import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defineEventStoreContractSuite } from '@bee-agent/storage/testing'
import { SQLiteEventStore, SQLiteStorage } from '../src/index.js'

defineEventStoreContractSuite(
  { describe, it, expect },
  {
    name: 'SQLiteEventStore (contract)',
    create: async () => {
      const storage = new SQLiteStorage(':memory:')
      await storage.migrate()
      return {
        store: new SQLiteEventStore(storage),
        transactions: storage.transactions,
        storage,
      }
    },
    destroy: async (subject) => subject.storage.close(),
  },
)

describe('SQLiteEventStore (dialect)', () => {
  it('replays persisted events after reopening the database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bee-agent-sqlite-'))
    const filename = join(directory, 'events.db')
    const taskId = randomUUID()

    try {
      const firstStorage = new SQLiteStorage(filename)
      await firstStorage.migrate()
      await new SQLiteEventStore(firstStorage).append({
        taskId,
        type: 'task.created',
        payload: { input: 'persist me' },
      })
      await firstStorage.close()

      const reopenedStorage = new SQLiteStorage(filename)
      const replayed = []
      for await (const event of new SQLiteEventStore(reopenedStorage).readTask(
        taskId,
      )) {
        replayed.push(event)
      }
      expect(replayed).toHaveLength(1)
      expect(replayed[0]?.payload).toEqual({ input: 'persist me' })
      await reopenedStorage.close()
    } finally {
      await rm(directory, { recursive: true })
    }
  })
})
