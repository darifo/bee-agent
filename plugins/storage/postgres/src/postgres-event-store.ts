import { randomUUID } from 'node:crypto'
import { AgentEventSchema, NewAgentEventSchema } from '@bee-agent/contracts'
import type { AgentEvent, NewAgentEvent } from '@bee-agent/contracts'
import type { EventStore } from '@bee-agent/event-store'
import type { PostgresStorage } from './postgres-storage.js'

interface EventRow {
  id: string
  task_id: string
  // int8 columns arrive as text; JSONB arrives already parsed.
  sequence: string
  type: string
  payload: unknown
  created_at: string
}

function mapEvent(row: EventRow): AgentEvent {
  return AgentEventSchema.parse({
    id: row.id,
    taskId: row.task_id,
    sequence: Number(row.sequence),
    type: row.type,
    payload: row.payload,
    createdAt: row.created_at,
  })
}

export class PostgresEventStore implements EventStore {
  readonly #storage: PostgresStorage

  constructor(storage: PostgresStorage) {
    this.#storage = storage
  }

  async append(event: NewAgentEvent): Promise<AgentEvent> {
    const [created] = await this.appendBatch([event])
    if (!created) throw new Error('Postgres Event Store failed to append event')
    return created
  }

  async appendBatch(events: readonly NewAgentEvent[]): Promise<AgentEvent[]> {
    if (events.length === 0) return []
    const parsed = events.map((event) => NewAgentEventSchema.parse(event))

    return this.#storage.transactions.transaction(async () => {
      const created: AgentEvent[] = []
      for (const event of parsed) {
        // One statement allocates atomically: concurrent transactions
        // contend on the row lock, then apply the increment — so sequences
        // stay unique and contiguous without an advisory lock.
        const allocated = await this.#storage.query<{ sequence: string }>(
          `INSERT INTO task_sequences (task_id, sequence)
             VALUES ($1, 1)
           ON CONFLICT (task_id)
             DO UPDATE SET sequence = task_sequences.sequence + 1
           RETURNING sequence`,
          [event.taskId],
        )
        const sequenceRow = allocated.rows[0]
        if (!sequenceRow) {
          throw new Error(`Failed to allocate sequence for ${event.taskId}`)
        }

        const record = AgentEventSchema.parse({
          ...event,
          id: randomUUID(),
          sequence: Number(sequenceRow.sequence),
          createdAt: new Date().toISOString(),
        })
        await this.#storage.query(
          `INSERT INTO agent_events
             (id, task_id, sequence, type, payload, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
          [
            record.id,
            record.taskId,
            record.sequence,
            record.type,
            JSON.stringify(record.payload),
            record.createdAt,
          ],
        )
        created.push(record)
      }
      return created
    })
  }

  async *readTask(
    taskId: string,
    afterSequence = 0,
  ): AsyncIterable<AgentEvent> {
    const result = await this.#storage.query<EventRow>(
      `SELECT id, task_id, sequence, type, payload, created_at
       FROM agent_events
       WHERE task_id = $1 AND sequence > $2
       ORDER BY sequence ASC`,
      [taskId, afterSequence],
    )
    for (const row of result.rows) yield mapEvent(row)
  }

  async getLatestSequence(taskId: string): Promise<number> {
    const result = await this.#storage.query<{ sequence: string }>(
      'SELECT sequence FROM task_sequences WHERE task_id = $1',
      [taskId],
    )
    const row = result.rows[0]
    return row === undefined ? 0 : Number(row.sequence)
  }

  async listTaskIds(): Promise<readonly string[]> {
    const result = await this.#storage.query<{ task_id: string }>(
      'SELECT task_id FROM task_sequences ORDER BY created_order ASC',
    )
    return result.rows.map((row) => row.task_id)
  }
}
