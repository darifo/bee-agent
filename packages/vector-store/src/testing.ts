import { randomUUID } from 'node:crypto'
import type { ExpectStatic, SuiteAPI, TestAPI } from 'vitest'
import type {
  EmbeddingRecord,
  EmbeddingSpace,
  VectorSearchQuery,
} from '@bee-agent/contracts'
import type { VectorStore } from './index.ts'

/**
 * The consumer's vitest test APIs, injected at registration time so the
 * suite never resolves a second vitest instance under pnpm (same rationale
 * as `@bee-agent/storage/testing`; only types are referenced here).
 */
export interface VectorStoreContractHarness {
  readonly describe: SuiteAPI
  readonly it: TestAPI
  readonly expect: ExpectStatic
}

export interface VectorStoreContractSubject {
  readonly store: VectorStore
}

export interface VectorStoreContractSetup<
  C extends VectorStoreContractSubject = VectorStoreContractSubject,
> {
  /** Describe-block label shown in test output. */
  readonly name: string
  /** Creates a migrated, isolated subject; `destroy` disposes it. */
  create(): Promise<C>
  destroy(subject: C): Promise<void> | void
}

function space(): EmbeddingSpace {
  return {
    id: `space-${randomUUID()}`,
    model: 'contract-suite',
    dimensions: 3,
    metric: 'cosine',
  }
}

async function withSubject<C extends VectorStoreContractSubject>(
  setup: VectorStoreContractSetup<C>,
  run: (subject: C) => Promise<void>,
): Promise<void> {
  const subject = await setup.create()
  try {
    await run(subject)
  } finally {
    await setup.destroy(subject)
  }
}

/**
 * The dialect-agnostic VectorStore contract suite. Fixtures pin the
 * embedding space to 3-dimensional cosine, so `score` assertions rely only
 * on metric ordering (lower score = more similar), never on absolute
 * values. Adapters must also reject embedding-space violations such as
 * wrong-dimension vectors (ADR 0005: pgvector validates dimensions).
 */
export function defineVectorStoreContractSuite<
  C extends VectorStoreContractSubject,
>(
  harness: VectorStoreContractHarness,
  setup: VectorStoreContractSetup<C>,
): void {
  const { describe, it, expect } = harness
  describe(setup.name, () => {
    it('roundtrips records and ranks the exact match first', () =>
      withSubject(setup, async ({ store }) => {
        const embeddingSpace = space()
        const workspaceId = randomUUID()
        const near: EmbeddingRecord = {
          id: randomUUID(),
          chunkId: randomUUID(),
          workspaceId,
          embeddingSpaceId: embeddingSpace.id,
          vector: [1, 0, 0],
          metadata: {},
        }
        const far: EmbeddingRecord = {
          ...near,
          id: randomUUID(),
          chunkId: randomUUID(),
          vector: [0, 1, 0],
        }
        await store.upsert(near)
        await store.upsert(far)

        const results = await store.search({
          workspaceId,
          embeddingSpace,
          vector: [1, 0, 0],
          limit: 10,
        })
        expect(results).toHaveLength(2)
        expect(results[0]?.record.id).toBe(near.id)
        expect(results[0]?.score).toBeLessThan(results[1]?.score ?? Infinity)
      }))

    it('orders results by ascending distance', () =>
      withSubject(setup, async ({ store }) => {
        const embeddingSpace = space()
        const workspaceId = randomUUID()
        const entries: readonly [string, readonly number[]][] = [
          ['near', [1, 0, 0]],
          ['middle', [0.7, 0.7, 0]],
          ['far', [0, 1, 0]],
        ]
        for (const [label, vector] of entries) {
          await store.upsert({
            id: randomUUID(),
            chunkId: randomUUID(),
            workspaceId,
            embeddingSpaceId: embeddingSpace.id,
            vector: [...vector],
            metadata: { label },
          })
        }

        const results = await store.search({
          workspaceId,
          embeddingSpace,
          vector: [1, 0, 0],
          limit: 10,
        })
        expect(results.map((result) => result.record.metadata.label)).toEqual([
          'near',
          'middle',
          'far',
        ])
        for (let index = 1; index < results.length; index += 1) {
          expect(results[index]?.score).toBeGreaterThanOrEqual(
            results[index - 1]?.score ?? -Infinity,
          )
        }
      }))

    it('isolates workspaces in search', () =>
      withSubject(setup, async ({ store }) => {
        const embeddingSpace = space()
        const own = randomUUID()
        const other = randomUUID()
        await store.upsert({
          id: randomUUID(),
          chunkId: randomUUID(),
          workspaceId: other,
          embeddingSpaceId: embeddingSpace.id,
          vector: [1, 0, 0],
          metadata: {},
        })

        const query: Omit<VectorSearchQuery, 'workspaceId'> = {
          embeddingSpace,
          vector: [1, 0, 0],
          limit: 10,
        }
        expect(await store.search({ ...query, workspaceId: own })).toEqual([])
        expect(
          await store.search({ ...query, workspaceId: other }),
        ).toHaveLength(1)
      }))

    it('scopes deletion to a workspace', () =>
      withSubject(setup, async ({ store }) => {
        const embeddingSpace = space()
        const workspaceId = randomUUID()
        const record: EmbeddingRecord = {
          id: randomUUID(),
          chunkId: randomUUID(),
          workspaceId,
          embeddingSpaceId: embeddingSpace.id,
          vector: [1, 0, 0],
          metadata: {},
        }
        await store.upsert(record)

        await store.delete(record.id, 'some-other-workspace')
        expect(
          await store.search({
            workspaceId,
            embeddingSpace,
            vector: [1, 0, 0],
            limit: 10,
          }),
        ).toHaveLength(1)

        await store.delete(record.id, workspaceId)
        expect(
          await store.search({
            workspaceId,
            embeddingSpace,
            vector: [1, 0, 0],
            limit: 10,
          }),
        ).toEqual([])
      }))

    it('respects the search limit', () =>
      withSubject(setup, async ({ store }) => {
        const embeddingSpace = space()
        const workspaceId = randomUUID()
        for (let index = 0; index < 3; index += 1) {
          await store.upsert({
            id: randomUUID(),
            chunkId: randomUUID(),
            workspaceId,
            embeddingSpaceId: embeddingSpace.id,
            vector: [1, index, 0],
            metadata: {},
          })
        }

        const results = await store.search({
          workspaceId,
          embeddingSpace,
          vector: [1, 0, 0],
          limit: 2,
        })
        expect(results).toHaveLength(2)
        expect(results[0]?.record.vector[1]).toBe(0)
      }))

    it('narrows searches by metadata containment', () =>
      withSubject(setup, async ({ store }) => {
        const embeddingSpace = space()
        const workspaceId = randomUUID()
        for (const kind of ['doc', 'code']) {
          await store.upsert({
            id: randomUUID(),
            chunkId: randomUUID(),
            workspaceId,
            embeddingSpaceId: embeddingSpace.id,
            vector: [1, 0, 0],
            metadata: { kind },
          })
        }

        const results = await store.search({
          workspaceId,
          embeddingSpace,
          vector: [1, 0, 0],
          limit: 10,
          metadata: { kind: 'code' },
        })
        expect(results).toHaveLength(1)
        expect(results[0]?.record.metadata).toEqual({ kind: 'code' })
      }))

    it('replaces the vector when a chunk is re-embedded', () =>
      withSubject(setup, async ({ store }) => {
        const embeddingSpace = space()
        const workspaceId = randomUUID()
        const chunkId = randomUUID()
        await store.upsert({
          id: randomUUID(),
          chunkId,
          workspaceId,
          embeddingSpaceId: embeddingSpace.id,
          vector: [1, 0, 0],
          metadata: { revision: 1 },
        })
        const revision = randomUUID()
        await store.upsert({
          id: revision,
          chunkId,
          workspaceId,
          embeddingSpaceId: embeddingSpace.id,
          vector: [0, 1, 0],
          metadata: { revision: 2 },
        })

        const results = await store.search({
          workspaceId,
          embeddingSpace,
          vector: [0, 1, 0],
          limit: 10,
        })
        expect(results).toHaveLength(1)
        expect(results[0]?.record.id).toBe(revision)
        expect(results[0]?.record.metadata).toEqual({ revision: 2 })
      }))

    it('rejects vectors that violate the embedding space dimensions', () =>
      withSubject(setup, async ({ store }) => {
        const embeddingSpace = space()
        const workspaceId = randomUUID()
        await store.upsert({
          id: randomUUID(),
          chunkId: randomUUID(),
          workspaceId,
          embeddingSpaceId: embeddingSpace.id,
          vector: [1, 0, 0],
          metadata: {},
        })

        await expect(
          store.upsert({
            id: randomUUID(),
            chunkId: randomUUID(),
            workspaceId,
            embeddingSpaceId: embeddingSpace.id,
            vector: [1, 0],
            metadata: {},
          }),
        ).rejects.toThrow(/dimension/i)
        await expect(
          store.search({
            workspaceId,
            embeddingSpace,
            vector: [1, 0],
            limit: 10,
          }),
        ).rejects.toThrow(/dimension/i)
      }))
  })
}
