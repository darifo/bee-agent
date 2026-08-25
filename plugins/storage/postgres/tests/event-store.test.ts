import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { defineEventStoreContractSuite } from '@bee-agent/storage/testing'
import { PostgresEventStore, PostgresStorage } from '../src/index.ts'

// Integration tests need a real PostgreSQL; point this at one to run them:
//   BEE_AGENT_STORAGE_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/bee_agent
// Without it the suite skips (CI and database-less environments).
const connectionString = process.env.BEE_AGENT_STORAGE_POSTGRES_URL ?? ''

async function createStorage(): Promise<PostgresStorage> {
  const storage = new PostgresStorage(connectionString)
  await storage.migrate()
  // Subjects share one database, so each starts from a clean slate.
  await storage.query('TRUNCATE agent_events, task_sequences')
  return storage
}

describe.skipIf(connectionString === '')('PostgreSQL storage', () => {
  defineEventStoreContractSuite(
    { describe, it, expect },
    {
      name: 'PostgresEventStore (contract)',
      create: async () => {
        const storage = await createStorage()
        return {
          store: new PostgresEventStore(storage),
          transactions: storage.transactions,
          storage,
        }
      },
      destroy: async (subject) => subject.storage.close(),
    },
  )

  it('rolls back raw writes made inside a failed transaction', async () => {
    const storage = await createStorage()
    try {
      await expect(
        storage.transactions.transaction(async () => {
          await storage.query(
            'INSERT INTO task_sequences (task_id, sequence) VALUES ($1, 1)',
            [randomUUID()],
          )
          throw new Error('abort')
        }),
      ).rejects.toThrow('abort')

      const counted = await storage.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM task_sequences',
      )
      expect(counted.rows[0]?.count).toBe(0)
    } finally {
      await storage.close()
    }
  })
})
