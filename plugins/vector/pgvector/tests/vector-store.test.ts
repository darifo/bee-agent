import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { EmbeddingSpace } from '@bee-agent/contracts'
import { defineVectorStoreContractSuite } from '@bee-agent/vector-store/testing'
import { PgvectorStore } from '../src/index.js'

// Integration tests need a real PostgreSQL with the pgvector extension;
// point this at one to run them (skips otherwise):
//   BEE_AGENT_STORAGE_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/bee_agent
const connectionString = process.env.BEE_AGENT_STORAGE_POSTGRES_URL ?? ''

async function openStore(): Promise<PgvectorStore> {
  const store = new PgvectorStore(connectionString)
  await store.migrate()
  return store
}

async function createStore(): Promise<PgvectorStore> {
  const store = await openStore()
  // Subjects share one database, so each starts from a clean slate.
  await store.query('TRUNCATE vector_embeddings, vector_embedding_spaces')
  return store
}

function metricSpace(metric: EmbeddingSpace['metric']): EmbeddingSpace {
  return {
    id: `space-${randomUUID()}`,
    model: 'metric-suite',
    dimensions: 3,
    metric,
  }
}

describe.skipIf(connectionString === '')('pgvector store', () => {
  defineVectorStoreContractSuite(
    { describe, it, expect },
    {
      name: 'PgvectorStore (contract)',
      create: async () => ({ store: await createStore() }),
      destroy: async (subject) => subject.store.close(),
    },
  )

  it('scores with each metric operator', async () => {
    const store = await createStore()
    try {
      const cases: readonly [
        EmbeddingSpace['metric'],
        readonly number[],
        readonly number[],
        number,
        number,
      ][] = [
        // query [1,0,0] against the two vectors: expected scores below.
        ['cosine', [1, 0, 0], [0, 1, 0], 0, 1],
        ['euclidean', [1, 0, 0], [1, 1, 0], 0, 1],
        ['inner_product', [2, 0, 0], [0.5, 0, 0], -2, -0.5],
      ]
      for (const [metric, near, far, nearScore, farScore] of cases) {
        const embeddingSpace = metricSpace(metric)
        const workspaceId = randomUUID()
        for (const vector of [near, far]) {
          await store.upsert({
            id: randomUUID(),
            chunkId: randomUUID(),
            workspaceId,
            embeddingSpaceId: embeddingSpace.id,
            vector: [...vector],
            metadata: {},
          })
        }

        const results = await store.search({
          workspaceId,
          embeddingSpace,
          vector: [1, 0, 0],
          limit: 10,
        })
        expect(results.map((result) => result.record.vector)).toEqual([
          near,
          far,
        ])
        expect(results[0]?.score).toBeCloseTo(nearScore, 5)
        expect(results[1]?.score).toBeCloseTo(farScore, 5)
      }
    } finally {
      await store.close()
    }
  })

  it('freezes the space description once a search registered it', async () => {
    const store = await createStore()
    try {
      const workspaceId = randomUUID()
      const registered = metricSpace('cosine')
      await store.search({
        workspaceId,
        embeddingSpace: registered,
        vector: [1, 0, 0],
        limit: 10,
      })

      const conflicting: EmbeddingSpace = {
        ...registered,
        metric: 'euclidean',
      }
      await expect(
        store.search({
          workspaceId,
          embeddingSpace: conflicting,
          vector: [1, 0, 0],
          limit: 10,
        }),
      ).rejects.toThrow(/is registered as/)
    } finally {
      await store.close()
    }
  })

  it('learns dimensions from upserts and validates searches against them', async () => {
    const store = await createStore()
    try {
      const workspaceId = randomUUID()
      const embeddingSpace = metricSpace('cosine')
      await store.upsert({
        id: randomUUID(),
        chunkId: randomUUID(),
        workspaceId,
        embeddingSpaceId: embeddingSpace.id,
        vector: [1, 0, 0],
        metadata: {},
      })

      // Same id, but the search declares a different dimensionality.
      const mismatched: EmbeddingSpace = { ...embeddingSpace, dimensions: 4 }
      await expect(
        store.search({
          workspaceId,
          embeddingSpace: mismatched,
          vector: [1, 0, 0, 0],
          limit: 10,
        }),
      ).rejects.toThrow(/dimension/i)

      const consistent = await store.search({
        workspaceId,
        embeddingSpace,
        vector: [1, 0, 0],
        limit: 10,
      })
      expect(consistent).toHaveLength(1)
    } finally {
      await store.close()
    }
  })

  it('replays searches after the pool is recreated', async () => {
    const store = await createStore()
    const workspaceId = randomUUID()
    const embeddingSpace = metricSpace('cosine')
    const id = randomUUID()
    await store.upsert({
      id,
      chunkId: randomUUID(),
      workspaceId,
      embeddingSpaceId: embeddingSpace.id,
      vector: [1, 0, 0],
      metadata: { origin: 'first pool' },
    })
    await store.close()

    const reopened = await openStore()
    try {
      const results = await reopened.search({
        workspaceId,
        embeddingSpace,
        vector: [1, 0, 0],
        limit: 10,
      })
      expect(results).toHaveLength(1)
      expect(results[0]?.record.id).toBe(id)
      expect(results[0]?.record.metadata).toEqual({ origin: 'first pool' })
    } finally {
      await reopened.close()
    }
  })
})
