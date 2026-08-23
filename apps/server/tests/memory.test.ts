import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PgvectorStore } from '@bee-agent/plugin-vector-pgvector'
import { buildServer } from '../src/index.js'

// Needs a real PostgreSQL with pgvector; without the URL the REST flow
// skips. The 404 test below runs everywhere.
//   BEE_AGENT_STORAGE_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/bee_agent
const url = process.env.BEE_AGENT_STORAGE_POSTGRES_URL ?? ''

describe('memory route mounting', () => {
  it('leaves /memory paths unregistered without a Vector Store', async () => {
    const server = await buildServer({
      sqliteFilename: ':memory:',
      logger: false,
    })
    const response = await server.app.inject({
      method: 'POST',
      url: '/memory/documents',
      payload: { workspaceId: 'ws', content: 'cat' },
    })
    expect(response.statusCode).toBe(404)
    await server.app.close()
  })
})

describe.skipIf(url === '')('memory REST flow on pgvector', () => {
  it('remembers, recalls, and forgets through the HTTP surface', async () => {
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
      const workspaceId = randomUUID()
      const remembered = await server.app.inject({
        method: 'POST',
        url: '/memory/documents',
        payload: {
          workspaceId,
          content: 'the cat sat on the mat and purred loudly',
          metadata: { kind: 'pet' },
        },
      })
      expect(remembered.statusCode).toBe(201)
      const { document, chunks } = remembered.json()
      expect(document.workspaceId).toBe(workspaceId)
      expect(chunks).toHaveLength(1)

      const recalled = await server.app.inject({
        method: 'POST',
        url: '/memory/recall',
        payload: { workspaceId, text: 'cat mat' },
      })
      expect(recalled.statusCode).toBe(200)
      const { results } = recalled.json()
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].chunk.content).toContain('cat sat')

      const forgotten = await server.app.inject({
        method: 'DELETE',
        url: `/memory/chunks/${chunks[0].id}`,
        query: { workspaceId },
      })
      expect(forgotten.statusCode).toBe(204)

      const afterForget = await server.app.inject({
        method: 'POST',
        url: '/memory/recall',
        payload: { workspaceId, text: 'cat mat' },
      })
      expect(afterForget.json().results).toEqual([])
    } finally {
      await server.app.close()
    }
  })
})
