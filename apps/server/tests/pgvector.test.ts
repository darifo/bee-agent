import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { EmbeddingSpace } from '@bee-agent/contracts'
import { PgvectorStore } from '@bee-agent/plugin-vector-pgvector'
import { vectorStoreService } from '@bee-agent/kernel'
import { buildServer } from '../src/index.ts'

// Needs a real PostgreSQL with pgvector; without the URL the integration
// part skips. The rejection test below runs everywhere.
//   BEE_AGENT_STORAGE_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/bee_agent
const url = process.env.BEE_AGENT_STORAGE_POSTGRES_URL ?? ''

describe('vector store mounting', () => {
  it('rejects pgvector without PostgreSQL storage', async () => {
    await expect(
      buildServer({ vectorStore: 'pgvector', logger: false }),
    ).rejects.toThrow(/requires postgresUrl/)
  })
})

describe.skipIf(url === '')('server with pgvector', () => {
  it('serves the Vector Store under the kernel service key', async () => {
    const cleaner = new PgvectorStore(url)
    await cleaner.migrate()
    await cleaner.query('TRUNCATE vector_embeddings, vector_embedding_spaces')
    await cleaner.close()

    const server = await buildServer({
      postgresUrl: url,
      vectorStore: 'pgvector',
      logger: false,
    })
    try {
      const store = server.kernel.getService(vectorStoreService)
      if (store === undefined) {
        throw new Error('vector-store service was not registered')
      }
      const embeddingSpace: EmbeddingSpace = {
        id: `space-${randomUUID()}`,
        model: 'server-suite',
        dimensions: 3,
        metric: 'cosine',
      }
      const workspaceId = randomUUID()
      const id = randomUUID()
      await store.upsert({
        id,
        chunkId: randomUUID(),
        workspaceId,
        embeddingSpaceId: embeddingSpace.id,
        vector: [1, 0, 0],
        metadata: { origin: 'server' },
      })

      const results = await store.search({
        workspaceId,
        embeddingSpace,
        vector: [1, 0, 0],
        limit: 10,
      })
      expect(results).toHaveLength(1)
      expect(results[0]?.record.id).toBe(id)
    } finally {
      await server.app.close()
    }
  })
})
