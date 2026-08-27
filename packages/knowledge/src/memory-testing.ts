import type { ExpectStatic, SuiteAPI, TestAPI } from 'vitest'
import type {
  MemoryContextInput,
  MemoryProvider,
  MemoryProvenance,
  MemoryQuery,
  NewMemoryClaimInput,
} from './memory.ts'
import {
  MEMORY_RENDERER_VERSION,
  MemoryHealthSchema,
  estimateMemoryTokens,
} from './memory.ts'

/**
 * The dialect-agnostic MemoryProvider contract suite (v1 refactor plan §5.5
 * WF4-A): any implementation — the embedded memory-bee provider or a remote
 * bridge — must satisfy these semantics. Vitest APIs are injected by the
 * consumer, same convention as the ChronicleStore suite.
 */

export interface MemoryContractHarness {
  readonly describe: SuiteAPI
  readonly it: TestAPI
  readonly expect: ExpectStatic
}

export interface MemoryContractSubject {
  readonly provider: MemoryProvider
}

export interface MemoryContractSetup<
  C extends MemoryContractSubject = MemoryContractSubject,
> {
  /** Describe-block label shown in test output. */
  readonly name: string
  /** Creates an isolated subject; `destroy` disposes it. */
  create(): Promise<C>
  destroy(subject: C): Promise<void> | void
}

async function withSubject<C extends MemoryContractSubject>(
  setup: MemoryContractSetup<C>,
  run: (subject: C) => Promise<void>,
): Promise<void> {
  const subject = await setup.create()
  try {
    await run(subject)
  } finally {
    await setup.destroy(subject)
  }
}

function provenance(sequence: number): MemoryProvenance {
  return {
    streamId: 'thread:contract',
    sequence,
    threadId: 'contract-thread',
    turnId: 'contract-turn',
    itemId: `item-${sequence}`,
  }
}

function claimInput(
  overrides: Partial<NewMemoryClaimInput> & {
    readonly statement: string
    readonly sequence: number
  },
): NewMemoryClaimInput {
  return {
    kind: 'preference',
    subject: { type: 'user' },
    provenance: provenance(overrides.sequence),
    recordedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

/** Runs a query and returns claim ids for compact assertions. */
async function queryIds(
  provider: MemoryProvider,
  query: MemoryQuery,
): Promise<string[]> {
  const claims = await provider.query(query)
  return claims.map((claim) => claim.id)
}

export function defineMemoryProviderContractSuite<
  C extends MemoryContractSubject,
>(harness: MemoryContractHarness, setup: MemoryContractSetup<C>): void {
  const { describe, it, expect } = harness
  describe(setup.name, () => {
    it('records ingested claims and returns them from query', () =>
      withSubject(setup, async ({ provider }) => {
        const recorded = await provider.ingest({
          claims: [
            claimInput({ statement: 'Prefer dark editor themes', sequence: 1 }),
          ],
        })
        expect(recorded.claims).toHaveLength(1)
        expect(recorded.claims[0]!.status).toBe('active')

        const ids = await queryIds(provider, { text: 'editor themes' })
        expect(ids).toEqual([recorded.claims[0]!.id])
      }))

    it('filters query by kind, subject type, and limit', () =>
      withSubject(setup, async ({ provider }) => {
        const recorded = await provider.ingest({
          claims: [
            claimInput({
              statement: 'Prefer kite lines',
              kind: 'preference',
              subject: { type: 'user' },
              sequence: 1,
            }),
            claimInput({
              statement: 'Uses kite fabric',
              kind: 'fact',
              subject: { type: 'project' },
              sequence: 2,
            }),
          ],
        })
        const [preference, fact] = recorded.claims

        expect(await queryIds(provider, { text: 'kite' })).toHaveLength(2)
        expect(
          await queryIds(provider, { text: 'kite', kinds: ['preference'] }),
        ).toEqual([preference!.id])
        expect(
          await queryIds(provider, { text: 'kite', subjectType: 'project' }),
        ).toEqual([fact!.id])
        expect(
          await queryIds(provider, { text: 'kite', limit: 1 }),
        ).toHaveLength(1)
      }))

    it('excludes claims whose validTime ended before the query', () =>
      withSubject(setup, async ({ provider }) => {
        await provider.ingest({
          claims: [
            claimInput({
              statement: 'Temporary crowbar setting',
              sequence: 1,
              validTime: {
                from: '2020-01-01T00:00:00Z',
                to: '2021-01-01T00:00:00Z',
              },
            }),
          ],
        })

        expect(
          await queryIds(provider, {
            text: 'crowbar',
            now: '2022-01-01T00:00:00Z',
          }),
        ).toEqual([])
        expect(
          await queryIds(provider, {
            text: 'crowbar',
            now: '2020-06-01T00:00:00Z',
          }),
        ).toHaveLength(1)
      }))

    it('buildContext fits the token budget and reports omissions', () =>
      withSubject(setup, async ({ provider }) => {
        await provider.ingest({
          claims: [
            claimInput({ statement: 'Prefer marshmallow roasts', sequence: 1 }),
            claimInput({ statement: 'Prefer violet notebooks', sequence: 2 }),
          ],
        })

        const roomy: MemoryContextInput = {
          text: 'marshmallow violet',
          budgetTokens: 4096,
        }
        const full = await provider.buildContext(roomy)
        expect(full.claimIds).toHaveLength(2)
        expect(full.omitted).toBe(0)
        expect(full.tokens).toBeLessThanOrEqual(roomy.budgetTokens)
        expect(full.content).toContain('marshmallow roasts')
        expect(full.content).toContain('violet notebooks')

        const tight = await provider.buildContext({
          text: 'marshmallow violet',
          budgetTokens: 4,
        })
        expect(tight.claimIds.length + tight.omitted).toBe(2)
        expect(tight.tokens).toBeLessThanOrEqual(4)
      }))

    it('supersedes correction targets and stops returning them', () =>
      withSubject(setup, async ({ provider }) => {
        const original = await provider.ingest({
          claims: [claimInput({ statement: 'Alpha beta gamma', sequence: 1 })],
        })
        const corrected = await provider.ingest({
          claims: [
            claimInput({
              statement: 'Delta epsilon zeta',
              kind: 'correction',
              sequence: 2,
              supersedes: [original.claims[0]!.id],
            }),
          ],
        })

        expect(await queryIds(provider, { text: 'alpha beta' })).toEqual([])
        expect(await queryIds(provider, { text: 'delta epsilon' })).toEqual([
          corrected.claims[0]!.id,
        ])
        const exported = await provider.export()
        const superseded = exported.claims.find(
          (claim) => claim.id === original.claims[0]!.id,
        )
        expect(superseded?.status).toBe('superseded')
      }))

    it('retract hides a claim from query but keeps it in export', () =>
      withSubject(setup, async ({ provider }) => {
        const recorded = await provider.ingest({
          claims: [
            claimInput({ statement: 'Omega sigma ritual', sequence: 1 }),
          ],
        })
        const id = recorded.claims[0]!.id

        await provider.retract(id, 'user asked to forget')

        expect(await queryIds(provider, { text: 'omega sigma' })).toEqual([])
        const exported = await provider.export()
        const retracted = exported.claims.find((claim) => claim.id === id)
        expect(retracted?.status).toBe('retracted')
      }))

    it('re-ingesting the same claim id is idempotent', () =>
      withSubject(setup, async ({ provider }) => {
        const input = claimInput({
          statement: 'Idempotent anchovy storage',
          sequence: 1,
          id: crypto.randomUUID(),
        })
        const first = await provider.ingest({ claims: [input] })
        const second = await provider.ingest({ claims: [input] })

        expect(second.claims[0]).toEqual(first.claims[0])
        const exported = await provider.export()
        expect(
          exported.claims.filter((claim) => claim.id === input.id),
        ).toHaveLength(1)
      }))

    it('derive returns deterministic preference candidates with provenance', () =>
      withSubject(setup, async ({ provider }) => {
        const result = await provider.derive({
          threadId: 'contract-thread',
          turnId: 'contract-turn',
          messages: [
            {
              role: 'user',
              content: 'From now on, always answer in Portuguese.',
              provenance: provenance(4),
            },
          ],
          now: '2026-01-02T00:00:00Z',
        })

        expect(result.claims.length).toBeGreaterThanOrEqual(1)
        const preference = result.claims.find(
          (claim) => claim.kind === 'preference',
        )
        expect(preference).toBeDefined()
        expect(preference!.subject.type).toBe('user')
        expect(preference!.statement).toContain('Portuguese')
        expect(preference!.provenance.streamId).toBe('thread:contract')
        expect(preference!.provenance.sequence).toBe(4)
      }))

    it('consolidate merges duplicate statements deterministically', () =>
      withSubject(setup, async ({ provider }) => {
        const earliest = await provider.ingest({
          claims: [
            claimInput({
              statement: 'Prefer tulip gardens',
              sequence: 1,
              recordedAt: '2026-01-01T00:00:00Z',
            }),
          ],
        })
        const later = await provider.ingest({
          claims: [
            claimInput({
              statement: 'Prefer tulip gardens',
              sequence: 2,
              recordedAt: '2026-02-01T00:00:00Z',
            }),
          ],
        })
        await provider.ingest({
          claims: [
            claimInput({
              statement: 'Uses cedar fencing',
              kind: 'fact',
              sequence: 3,
            }),
          ],
        })

        const report = await provider.consolidate()
        expect(report.considered).toBeGreaterThan(0)
        expect(report.merged).toHaveLength(1)
        expect(report.merged[0]!.kept).toBe(earliest.claims[0]!.id)
        expect(report.merged[0]!.superseded).toEqual([later.claims[0]!.id])

        const remaining = await queryIds(provider, { text: 'tulip gardens' })
        expect(remaining).toEqual([earliest.claims[0]!.id])
      }))

    it('getRepresentation renders claims with the stable renderer version', () =>
      withSubject(setup, async ({ provider }) => {
        const recorded = await provider.ingest({
          claims: [
            claimInput({ statement: 'Prefer copper kettles', sequence: 1 }),
            claimInput({
              statement: 'Uses cedar fencing',
              kind: 'fact',
              sequence: 2,
            }),
          ],
        })

        const representation = await provider.getRepresentation(
          recorded.claims.map((claim) => claim.id),
        )
        expect([...representation.claimIds].sort()).toEqual(
          [...recorded.claims.map((claim) => claim.id)].sort(),
        )
        expect(representation.rendererVersion).toBe(MEMORY_RENDERER_VERSION)
        expect(representation.content).toContain('copper kettles')
        expect(representation.content).toContain('cedar fencing')
        expect(representation.tokens).toBe(
          estimateMemoryTokens(representation.content),
        )
      }))

    it('health reports a parseable status', () =>
      withSubject(setup, async ({ provider }) => {
        const health = await provider.health()
        expect(MemoryHealthSchema.parse(health)).toEqual(health)
      }))
  })
}
