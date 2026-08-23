---
'@bee-agent/storage': minor
'@bee-agent/plugin-storage-postgres': minor
'@bee-agent/plugin-storage-sqlite': minor
'@bee-agent/server': minor
---

Added the PostgreSQL storage stage (ADR 0004: one dialect per instance, never dual writes).

- `@bee-agent/storage`: new `@bee-agent/storage/testing` export with `defineEventStoreContractSuite`, the dialect-agnostic EventStore + TransactionManager contract suite both adapters run unchanged; the suite takes the consumer's vitest test APIs as a harness so the shared package never resolves a second vitest instance. `TransactionManager.transaction()` now documents join semantics: re-entrant calls join the caller's active transaction and only the outermost call commits or rolls back.
- `@bee-agent/plugin-storage-postgres`: new adapter implementing the shared contracts on `pg` pools — per-transaction clients routed via `AsyncLocalStorage`, atomic per-task sequence allocation (`INSERT … ON CONFLICT … DO UPDATE … RETURNING`), JSONB event payloads, oldest-first `listTaskIds()` on an identity column. Integration tests run against a real PostgreSQL via `BEE_AGENT_STORAGE_POSTGRES_URL` and skip without it.
- `@bee-agent/plugin-storage-sqlite`: `transaction()` now joins the ambient transaction when re-entered — previously a nested call deadlocked on the serialization tail (and a nested `BEGIN` would have failed); tests moved onto the shared contract suite.
- `@bee-agent/server`: `postgresUrl` option mounts the PostgreSQL plugin instead of SQLite (mutually exclusive, enforced); `main.ts` selects the dialect via `BEE_AGENT_STORAGE_DIALECT` / `BEE_AGENT_STORAGE_POSTGRES_URL`; gated integration test proves task events survive a full server restart.
