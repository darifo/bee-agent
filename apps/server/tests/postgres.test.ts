import { describe, expect, it } from 'vitest'
import { PostgresStorage } from '@bee-agent/plugin-storage-postgres'
import { buildServer } from '../src/index.js'

// Needs a real PostgreSQL; without the URL the integration part skips.
//   BEE_AGENT_STORAGE_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/bee_agent
const url = process.env.BEE_AGENT_STORAGE_POSTGRES_URL ?? ''

describe('storage dialect selection', () => {
  it('rejects configuring both dialects at once', async () => {
    await expect(
      buildServer({
        sqliteFilename: ':memory:',
        postgresUrl: 'postgres://invalid.invalid/invalid',
        logger: false,
      }),
    ).rejects.toThrow(/one storage dialect per instance/)
  })
})

describe.skipIf(url === '')('server with PostgreSQL storage', () => {
  it('persists task events across server restarts', async () => {
    const cleaner = new PostgresStorage(url)
    await cleaner.migrate()
    await cleaner.query('TRUNCATE agent_events, task_sequences')
    await cleaner.close()

    const first = await buildServer({ postgresUrl: url, logger: false })
    const spec = await first.runtime.createTask({
      input: 'pg roundtrip',
      agentId: 'agent.mock',
      metadata: {},
    })
    await first.runtime.run(spec.id)
    expect((await first.runtime.getSnapshot(spec.id)).state).toBe('completed')
    await first.app.close()

    const second = await buildServer({ postgresUrl: url, logger: false })
    const listed = await second.runtime.listTasks()
    expect(listed.map((snapshot) => snapshot.taskId)).toContain(spec.id)
    const replayed = await second.runtime.getSnapshot(spec.id)
    expect(replayed.state).toBe('completed')
    expect(replayed.lastSequence).toBeGreaterThan(0)
    await second.app.close()
  })
})
