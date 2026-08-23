export type StorageDialect = 'sqlite' | 'postgres'

export interface TransactionContext {
  readonly dialect: StorageDialect
}

export interface TransactionManager {
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
