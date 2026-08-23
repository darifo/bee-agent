import Database from 'better-sqlite3'
import type {
  StorageProvider,
  TransactionContext,
  TransactionManager,
} from '@bee-agent/storage'
import { initialMigration } from './migration.js'

class SQLiteTransactionManager implements TransactionManager {
  readonly #database: Database.Database
  #tail: Promise<void> = Promise.resolve()

  constructor(database: Database.Database) {
    this.#database = database
  }

  async transaction<T>(
    callback: (transaction: TransactionContext) => Promise<T>,
  ): Promise<T> {
    let release!: () => void
    const previous = this.#tail
    this.#tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous

    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = await callback({ dialect: 'sqlite' })
      this.#database.exec('COMMIT')
      return result
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    } finally {
      release()
    }
  }
}

export class SQLiteStorage implements StorageProvider {
  readonly dialect = 'sqlite' as const
  readonly database: Database.Database
  readonly transactions: TransactionManager
  #closed = false

  constructor(filename: string) {
    this.database = new Database(filename)
    this.database.pragma('foreign_keys = ON')
    this.database.pragma('journal_mode = WAL')
    this.transactions = new SQLiteTransactionManager(this.database)
  }

  async migrate(): Promise<void> {
    this.database.exec(initialMigration)
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.database.close()
      this.#closed = true
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }
}
