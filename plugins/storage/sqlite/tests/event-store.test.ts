import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SQLiteEventStore, SQLiteStorage } from '../src/index.js'

describe('SQLiteEventStore', () => {
  let storage: SQLiteStorage
  let store: SQLiteEventStore

  beforeEach(async () => {
    storage = new SQLiteStorage(':memory:')
    await storage.migrate()
    store = new SQLiteEventStore(storage)
  })

  afterEach(async () => storage.close())

  it('persists and replays events in sequence', async () => {
    const taskId = randomUUID()
    await store.appendBatch([
      { taskId, type: 'task.created', payload: { input: '1 + 1' } },
      { taskId, type: 'task.completed', payload: { result: 2 } },
    ])

    const replayed = []
    for await (const event of store.readTask(taskId)) replayed.push(event)

    expect(replayed.map(({ sequence, type }) => ({ sequence, type }))).toEqual([
      { sequence: 1, type: 'task.created' },
      { sequence: 2, type: 'task.completed' },
    ])
    expect(await store.getLatestSequence(taskId)).toBe(2)
  })

  it('atomically allocates unique sequences for concurrent appends', async () => {
    const taskId = randomUUID()
    const events = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.append({ taskId, type: 'test.event', payload: { index } }),
      ),
    )
    expect(events.map((event) => event.sequence).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    )
  })

  it('rolls back failed storage transactions', async () => {
    await expect(
      storage.transactions.transaction(async () => {
        storage.database
          .prepare(
            'INSERT INTO task_sequences (task_id, sequence) VALUES (?, ?)',
          )
          .run(randomUUID(), 1)
        throw new Error('abort')
      }),
    ).rejects.toThrow('abort')

    const row = storage.database
      .prepare<[], { count: number }>(
        'SELECT COUNT(*) AS count FROM task_sequences',
      )
      .get()
    expect(row?.count).toBe(0)
  })

  it('supports replaying after a checkpoint sequence', async () => {
    const taskId = randomUUID()
    await store.appendBatch([
      { taskId, type: 'event.1', payload: {} },
      { taskId, type: 'event.2', payload: {} },
      { taskId, type: 'event.3', payload: {} },
    ])
    const replayed = []
    for await (const event of store.readTask(taskId, 2)) replayed.push(event)
    expect(replayed.map((event) => event.sequence)).toEqual([3])
  })

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
