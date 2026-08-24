import Database from 'better-sqlite3'
import { ChronicleEventSchema } from '@bee-agent/knowledge'
import type {
  ChronicleAppendOptions,
  ChronicleEvent,
  ChronicleSchemaRegistry,
  ChronicleStore,
  NewChronicleEvent,
} from '@bee-agent/knowledge'
import { ChronicleSequenceConflictError } from '@bee-agent/knowledge'
import { chronicleMigration } from './chronicle-migration.js'

export interface SQLiteChronicleStoreOptions {
  readonly registry: ChronicleSchemaRegistry
  /** Opens a dedicated database when no `database` handle is given. */
  readonly filename?: string | undefined
  /** Shares an already-open database (e.g. the storage plugin's). */
  readonly database?: InstanceType<typeof Database> | undefined
}

/**
 * Embedded SQLite {@link ChronicleStore}: the default v1 store. Sequences
 * are allocated inside a single transaction together with the inserts, so
 * `(stream_id, sequence)` uniqueness and the stream-tail counter can never
 * drift apart. Retried appends with matching event ids return the stored
 * rows (idempotent); anything else at the expected position conflicts.
 */
export class SQLiteChronicleStore implements ChronicleStore {
  readonly #database: InstanceType<typeof Database>
  readonly #registry: ChronicleSchemaRegistry
  readonly #ownsDatabase: boolean
  readonly #appendTransaction: (
    streamId: string,
    events: readonly NewChronicleEvent[],
    expectedSequence: number,
  ) => ChronicleEvent[]

  constructor(options: SQLiteChronicleStoreOptions) {
    if (options.database !== undefined) {
      this.#database = options.database
      this.#ownsDatabase = false
    } else {
      this.#database = new Database(options.filename ?? ':memory:')
      this.#database.pragma('journal_mode = WAL')
      this.#database.pragma('foreign_keys = ON')
      this.#ownsDatabase = true
    }
    this.#registry = options.registry
    this.#database.exec(chronicleMigration)

    const appendLocked = (
      streamId: string,
      events: readonly NewChronicleEvent[],
      expectedSequence: number,
    ): ChronicleEvent[] => {
      this.#database
        .prepare(
          'INSERT OR IGNORE INTO chronicle_streams (stream_id, sequence) VALUES (?, 0)',
        )
        .run(streamId)
      const tail = this.#database
        .prepare<[string], { sequence: number }>(
          'SELECT sequence FROM chronicle_streams WHERE stream_id = ?',
        )
        .get(streamId)
      const actualNext = (tail?.sequence ?? 0) + 1
      if (expectedSequence < 1 || expectedSequence > actualNext) {
        throw new ChronicleSequenceConflictError(
          streamId,
          expectedSequence,
          actualNext,
        )
      }
      if (expectedSequence !== actualNext) {
        const window = this.#database
          .prepare<[string, number, number], { event_json: string }>(
            `SELECT event_json FROM chronicle_events
             WHERE stream_id = ? AND sequence >= ? AND sequence < ?
             ORDER BY sequence ASC`,
          )
          .all(streamId, expectedSequence, expectedSequence + events.length)
        const idempotent =
          window.length === events.length &&
          window.every(
            (row, index) =>
              (JSON.parse(row.event_json) as ChronicleEvent).eventId ===
              events[index]?.eventId,
          )
        if (!idempotent) {
          throw new ChronicleSequenceConflictError(
            streamId,
            expectedSequence,
            actualNext,
          )
        }
        return window.map((row) =>
          ChronicleEventSchema.parse(JSON.parse(row.event_json)),
        )
      }

      const ingestTime = new Date().toISOString()
      const insert = this.#database.prepare(
        `INSERT INTO chronicle_events (stream_id, sequence, event_id, event_json)
         VALUES (?, ?, ?, ?)`,
      )
      const writeTail = this.#database.prepare<[number, string]>(
        'UPDATE chronicle_streams SET sequence = ? WHERE stream_id = ?',
      )
      const stored = events.map((event, index) => ({
        ...event,
        streamId,
        sequence: expectedSequence + index,
        ingestTime,
      }))
      for (const event of stored) {
        insert.run(streamId, event.sequence, event.eventId, JSON.stringify(event))
      }
      writeTail.run(stored[stored.length - 1]?.sequence ?? 0, streamId)
      return stored
    }

    this.#appendTransaction = this.#database.transaction(appendLocked)
  }

  async append(
    streamId: string,
    events: readonly NewChronicleEvent[],
    options: ChronicleAppendOptions,
  ): Promise<readonly ChronicleEvent[]> {
    if (events.length === 0) return []
    for (const event of events) {
      this.#registry.validateNew(event)
    }
    return this.#appendTransaction(streamId, events, options.expectedSequence)
  }

  async *readStream(
    streamId: string,
    afterSequence = 0,
  ): AsyncIterable<ChronicleEvent> {
    const rows = this.#database
      .prepare<[string, number], { event_json: string }>(
        `SELECT event_json FROM chronicle_events
         WHERE stream_id = ? AND sequence > ?
         ORDER BY sequence ASC`,
      )
      .all(streamId, afterSequence)
    for (const row of rows) {
      yield ChronicleEventSchema.parse(JSON.parse(row.event_json))
    }
  }

  async getLatestSequence(streamId: string): Promise<number> {
    const row = this.#database
      .prepare<[string], { sequence: number }>(
        'SELECT sequence FROM chronicle_streams WHERE stream_id = ?',
      )
      .get(streamId)
    return row?.sequence ?? 0
  }

  async listStreams(): Promise<readonly string[]> {
    const rows = this.#database
      .prepare<[], { stream_id: string }>(
        'SELECT stream_id FROM chronicle_streams ORDER BY rowid ASC',
      )
      .all()
    return rows.map((row) => row.stream_id)
  }

  async close(): Promise<void> {
    if (this.#ownsDatabase) this.#database.close()
  }
}
