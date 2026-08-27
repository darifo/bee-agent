import type { ExpectStatic, SuiteAPI, TestAPI } from 'vitest'
import type {
  MemoryClaim,
  MemoryContext,
  MemoryContextInput,
  MemoryConsolidationReport,
  MemoryDerivationInput,
  MemoryDerivationResult,
  MemoryExport,
  MemoryHealth,
  MemoryIngestInput,
  MemoryIngestResult,
  MemoryObservation,
  MemoryProvider,
  MemoryProvenance,
  MemoryQuery,
  MemoryRepresentation,
  NewMemoryClaimInput,
} from './memory.ts'
import {
  MEMORY_RENDERER_VERSION,
  MemoryClaimNotFoundError,
  MemoryClaimSchema,
  MemoryHealthSchema,
  MemoryObservationSchema,
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

    it('keeps conflicting claims distinct until a correction resolves one', () =>
      withSubject(setup, async ({ provider }) => {
        // Two contradictory preferences with disjoint vocabulary: without a
        // correction the provider must not silently drop either side —
        // both stay queryable so the conflict is visible to the caller.
        await provider.ingest({
          claims: [
            claimInput({ statement: 'Prefer rosemary hydrosol', sequence: 1 }),
            claimInput({
              statement: 'Prefer sandalwood candles',
              sequence: 2,
              recordedAt: '2026-02-01T00:00:00Z',
            }),
          ],
        })

        expect(
          await queryIds(provider, { text: 'rosemary hydrosol' }),
        ).toHaveLength(1)
        expect(
          await queryIds(provider, { text: 'sandalwood candles' }),
        ).toHaveLength(1)
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

// ---------------------------------------------------------------------------
// Reference in-memory provider
// ---------------------------------------------------------------------------

/**
 * A non-persistent reference {@link MemoryProvider} (same convention as the
 * kanban package's MemoryKanbanStore): the default harness for validating the
 * contract suite itself and for exercising bridges (memory-remote) in tests.
 * Production memory lives in the embedded or remote providers.
 */
export class InMemoryMemoryProvider implements MemoryProvider {
  readonly #claims = new Map<string, MemoryClaim>()
  readonly #observations = new Map<string, MemoryObservation>()
  readonly #order: string[] = []
  readonly #now: () => string

  constructor(options: { now?: () => string } = {}) {
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async ingest(input: MemoryIngestInput): Promise<MemoryIngestResult> {
    const now = this.#now()
    const claims: MemoryClaim[] = []
    const observations: MemoryObservation[] = []
    for (const candidate of input.claims ?? []) {
      const existing =
        candidate.id === undefined ? undefined : this.#claims.get(candidate.id)
      if (existing !== undefined) {
        claims.push(existing)
        continue
      }
      const claim: MemoryClaim = MemoryClaimSchema.parse({
        id: candidate.id ?? crypto.randomUUID(),
        kind: candidate.kind,
        statement: candidate.statement,
        subject: candidate.subject,
        provenance: candidate.provenance,
        validTime: candidate.validTime ?? { from: now },
        confidence: candidate.confidence ?? 1,
        status: 'active',
        supersedes: [...(candidate.supersedes ?? [])],
        recordedAt: candidate.recordedAt ?? now,
      })
      for (const targetId of claim.supersedes) {
        const target = this.#claims.get(targetId)
        if (target !== undefined && target.status === 'active') {
          this.#claims.set(targetId, { ...target, status: 'superseded' })
        }
      }
      this.#order.push(claim.id)
      this.#claims.set(claim.id, claim)
      claims.push(claim)
    }
    for (const candidate of input.observations ?? []) {
      const observation: MemoryObservation = MemoryObservationSchema.parse({
        id: candidate.id ?? crypto.randomUUID(),
        content: candidate.content,
        provenance: candidate.provenance,
        observedAt: candidate.observedAt ?? now,
        confidence: candidate.confidence ?? 1,
      })
      this.#observations.set(observation.id, observation)
      observations.push(observation)
    }
    return { claims, observations }
  }

  async query(query: MemoryQuery): Promise<readonly MemoryClaim[]> {
    const now = query.now ?? this.#now()
    const terms = new Set(
      (query.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
        (term) => term.length > 2,
      ),
    )
    const eligible = [...this.#claims.values()].filter((claim) => {
      if (claim.status !== 'active') return false
      if (claim.validTime.from > now) return false
      if (claim.validTime.to !== undefined && claim.validTime.to <= now) {
        return false
      }
      if (query.kinds !== undefined && !query.kinds.includes(claim.kind)) {
        return false
      }
      if (
        query.subjectType !== undefined &&
        claim.subject.type !== query.subjectType
      ) {
        return false
      }
      if (terms.size === 0) return true
      const statement = claim.statement.toLowerCase()
      for (const term of terms) {
        if (statement.includes(term)) return true
      }
      return false
    })
    eligible.sort(
      (a, b) =>
        b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id),
    )
    return query.limit === undefined ? eligible : eligible.slice(0, query.limit)
  }

  async buildContext(input: MemoryContextInput): Promise<MemoryContext> {
    const claims = await this.query(input)
    const lines = claims.map((claim) => `[${claim.kind}] ${claim.statement}`)
    const included: string[] = []
    const claimIds: string[] = []
    let omitted = 0
    for (let i = 0; i < lines.length; i += 1) {
      const candidate = [...included, lines[i]!].join('\n')
      if (estimateMemoryTokens(candidate) > input.budgetTokens) {
        omitted += 1
        continue
      }
      included.push(lines[i]!)
      claimIds.push(claims[i]!.id)
    }
    const content = included.join('\n')
    return {
      content,
      claimIds,
      tokens: estimateMemoryTokens(content),
      omitted,
    }
  }

  async getRepresentation(
    claimIds: readonly string[],
  ): Promise<MemoryRepresentation> {
    if (claimIds.length === 0) {
      throw new Error('getRepresentation requires at least one claim id')
    }
    const claims = [...claimIds].sort().map((claimId) => {
      const claim = this.#claims.get(claimId)
      if (claim === undefined) throw new MemoryClaimNotFoundError(claimId)
      return claim
    })
    const content = claims
      .map((claim) => `[${claim.kind}] ${claim.statement}`)
      .join('\n')
    return {
      id: crypto.randomUUID(),
      claimIds: [...claimIds].sort(),
      content,
      rendererVersion: MEMORY_RENDERER_VERSION,
      tokens: estimateMemoryTokens(content),
    }
  }

  async derive(input: MemoryDerivationInput): Promise<MemoryDerivationResult> {
    const claims: NewMemoryClaimInput[] = []
    for (const message of input.messages) {
      if (message.role === 'tool') continue
      for (const sentence of message.content.split(/[.!?\n]+/)) {
        const trimmed = sentence.trim()
        if (
          trimmed === '' ||
          !/\b(always|never|prefer|from now on)\b/i.test(trimmed)
        ) {
          continue
        }
        claims.push({
          kind: 'preference',
          statement: trimmed,
          subject: { type: 'user' },
          provenance: message.provenance,
          confidence: 0.6,
        })
      }
    }
    return { claims, observations: [] }
  }

  async consolidate(): Promise<MemoryConsolidationReport> {
    const groups = new Map<string, MemoryClaim[]>()
    const active: MemoryClaim[] = []
    for (const id of this.#order) {
      const claim = this.#claims.get(id)
      if (claim === undefined || claim.status !== 'active') continue
      active.push(claim)
      const key = [
        claim.kind,
        claim.subject.type,
        claim.subject.id ?? '',
        claim.statement.trim().toLowerCase(),
      ].join('|')
      const group = groups.get(key) ?? []
      group.push(claim)
      groups.set(key, group)
    }
    const merged: {
      kept: string
      superseded: readonly string[]
    }[] = []
    for (const group of groups.values()) {
      if (group.length < 2) continue
      const sorted = [...group].sort(
        (a, b) =>
          a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id),
      )
      const kept = sorted[0]!
      for (const duplicate of sorted.slice(1)) {
        this.#claims.set(duplicate.id, { ...duplicate, status: 'superseded' })
      }
      merged.push({
        kept: kept.id,
        superseded: sorted.slice(1).map((c) => c.id),
      })
    }
    return { considered: active.length, merged, at: this.#now() }
  }

  async retract(claimId: string): Promise<MemoryClaim> {
    const claim = this.#claims.get(claimId)
    if (claim === undefined) throw new MemoryClaimNotFoundError(claimId)
    const retracted = { ...claim, status: 'retracted' as const }
    this.#claims.set(claimId, retracted)
    return retracted
  }

  async export(): Promise<MemoryExport> {
    return {
      claims: this.#order.flatMap((id) => {
        const claim = this.#claims.get(id)
        return claim === undefined ? [] : [claim]
      }),
      observations: [...this.#observations.values()],
      exportedAt: this.#now(),
    }
  }

  async health(): Promise<MemoryHealth> {
    return { status: 'healthy' }
  }
}
