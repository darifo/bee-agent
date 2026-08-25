import { randomUUID } from 'node:crypto'
import { AgentEventSchema, NewAgentEventSchema } from '@bee-agent/contracts'
import type { AgentEvent, NewAgentEvent } from '@bee-agent/contracts'
import type { EventStore } from '@bee-agent/event-store'
import type { SQLiteStorage } from './sqlite-storage.ts'

interface EventRow {
  id: string
  task_id: string
  sequence: number
  type: string
  payload: string
  created_at: string
}

function mapEvent(row: EventRow): AgentEvent {
  return AgentEventSchema.parse({
    id: row.id,
    taskId: row.task_id,
    sequence: row.sequence,
    type: row.type,
    payload: JSON.parse(row.payload) as unknown,
    createdAt: row.created_at,
  })
}

export class SQLiteEventStore implements EventStore {
  readonly #storage: SQLiteStorage

  constructor(storage: SQLiteStorage) {
    this.#storage = storage
  }

  async append(event: NewAgentEvent): Promise<AgentEvent> {
    const [created] = await this.appendBatch([event])
    if (!created) throw new Error('SQLite Event Store failed to append event')
    return created
  }

  async appendBatch(events: readonly NewAgentEvent[]): Promise<AgentEvent[]> {
    if (events.length === 0) return []
    const parsed = events.map((event) => NewAgentEventSchema.parse(event))

    return this.#storage.transactions.transaction(async () => {
      const ensureSequence = this.#storage.database.prepare(
        'INSERT OR IGNORE INTO task_sequences (task_id, sequence) VALUES (?, 0)',
      )
      const nextSequence = this.#storage.database.prepare<
        [string],
        { sequence: number }
      >(
        'UPDATE task_sequences SET sequence = sequence + 1 WHERE task_id = ? RETURNING sequence',
      )
      const insert = this.#storage.database.prepare(
        `INSERT INTO agent_events
          (id, task_id, sequence, type, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )

      return parsed.map((event) => {
        ensureSequence.run(event.taskId)
        const allocated = nextSequence.get(event.taskId)
        if (!allocated)
          throw new Error(`Failed to allocate sequence for ${event.taskId}`)

        const created = AgentEventSchema.parse({
          ...event,
          id: randomUUID(),
          sequence: allocated.sequence,
          createdAt: new Date().toISOString(),
        })
        insert.run(
          created.id,
          created.taskId,
          created.sequence,
          created.type,
          JSON.stringify(created.payload),
          created.createdAt,
        )
        return created
      })
    })
  }

  async *readTask(
    taskId: string,
    afterSequence = 0,
  ): AsyncIterable<AgentEvent> {
    const rows = this.#storage.database
      .prepare<[string, number], EventRow>(
        `SELECT id, task_id, sequence, type, payload, created_at
         FROM agent_events
         WHERE task_id = ? AND sequence > ?
         ORDER BY sequence ASC`,
      )
      .all(taskId, afterSequence)
    for (const row of rows) yield mapEvent(row)
  }

  async getLatestSequence(taskId: string): Promise<number> {
    const row = this.#storage.database
      .prepare<[string], { sequence: number }>(
        'SELECT sequence FROM task_sequences WHERE task_id = ?',
      )
      .get(taskId)
    return row?.sequence ?? 0
  }

  async listTaskIds(): Promise<readonly string[]> {
    const rows = this.#storage.database
      .prepare<[], { task_id: string }>(
        'SELECT task_id FROM task_sequences ORDER BY rowid ASC',
      )
      .all()
    return rows.map((row) => row.task_id)
  }
}
