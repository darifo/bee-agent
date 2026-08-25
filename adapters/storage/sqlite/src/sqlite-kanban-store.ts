import { ChronicleKanbanStore } from '@bee-agent/kanban'
import { SQLiteChronicleStore } from './sqlite-chronicle-store.ts'
import type { SQLiteChronicleStoreOptions } from './sqlite-chronicle-store.ts'

/**
 * The embedded SQLite {@link KanbanStore}: a `ChronicleKanbanStore` projection
 * backed by `SQLiteChronicleStore`. Kanban facts are durable in the
 * `chronicle_events` table; the projection is rebuilt from the log on
 * {@link rebuild} after a restart, so no separate kanban table is needed.
 */
export class SQLiteKanbanStore extends ChronicleKanbanStore {
  readonly #chronicle: SQLiteChronicleStore

  constructor(options: SQLiteChronicleStoreOptions) {
    const chronicle = new SQLiteChronicleStore(options)
    super(chronicle)
    this.#chronicle = chronicle
  }

  override async close(): Promise<void> {
    await super.close()
    await this.#chronicle.close()
  }
}
