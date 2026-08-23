export type StorageDialect = 'sqlite' | 'postgres'

export interface TransactionContext {
  readonly dialect: StorageDialect
}

export interface TransactionManager {
  /**
   * Runs the callback inside a transaction. Re-entrant calls made while a
   * transaction is already active on the same provider join it — only the
   * outermost call controls commit and rollback.
   */
  transaction<T>(
    callback: (transaction: TransactionContext) => Promise<T>,
  ): Promise<T>
}

export interface StorageProvider extends AsyncDisposable {
  readonly dialect: StorageDialect
  readonly transactions: TransactionManager
  migrate(): Promise<void>
  close(): Promise<void>
}
