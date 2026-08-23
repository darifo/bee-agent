import { AsyncLocalStorage } from 'node:async_hooks'
import pg from 'pg'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import type {
  StorageProvider,
  TransactionContext,
  TransactionManager,
} from '@bee-agent/storage'
import { initialMigration } from './migration.js'

/**
 * Tracks the client owned by the innermost running transaction so
 * `PostgresStorage.query` routes statements over the transaction's own
 * connection. Pool connections are isolated from each other, so — unlike
 * the single-connection SQLite adapter — a plain pooled query could never
 * accidentally join a transaction; the routing is what makes the ambient
 * `TransactionContext` contract work.
 */
class PostgresTransactionManager implements TransactionManager {
  readonly #pool: Pool
  readonly #context: AsyncLocalStorage<PoolClient>

  constructor(pool: Pool, context: AsyncLocalStorage<PoolClient>) {
    this.#pool = pool
    this.#context = context
  }

  async transaction<T>(
    callback: (transaction: TransactionContext) => Promise<T>,
  ): Promise<T> {
    // Re-entrant calls join the ambient transaction: a second pooled
    // client would commit independently and escape the caller's rollback.
    // Only the outermost call owns the client and BEGIN/COMMIT lifecycle.
    if (this.#context.getStore() !== undefined) {
      return callback({ dialect: 'postgres' })
    }

    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      const result = await this.#context.run(client, () =>
        callback({ dialect: 'postgres' }),
      )
      await client.query('COMMIT')
      return result
    } catch (error) {
      // Best-effort rollback; the original error is what callers need.
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}

export class PostgresStorage implements StorageProvider {
  readonly dialect = 'postgres' as const
  readonly pool: Pool
  readonly transactions: TransactionManager
  readonly #transactionContext = new AsyncLocalStorage<PoolClient>()
  #closed = false

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString })
    this.transactions = new PostgresTransactionManager(
      this.pool,
      this.#transactionContext,
    )
  }

  /**
   * Runs a query on the connection of the innermost running transaction
   * (when called inside one) or on the pool otherwise. Adapters keep the
   * dialect routing internal per ADR 0004; callers never handle clients.
   */
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    const args = params === undefined ? undefined : [...params]
    const client = this.#transactionContext.getStore()
    if (client !== undefined) return client.query<R>(text, args)
    return this.pool.query<R>(text, args)
  }

  async migrate(): Promise<void> {
    // Multi-statement DDL rides the simple protocol, which forbids params.
    await this.pool.query(initialMigration)
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      await this.pool.end()
      this.#closed = true
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }
}
