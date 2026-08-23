# PostgreSQL storage plugin

PostgreSQL adapter for the shared `StorageProvider` and `EventStore` contracts
(ADR 0004: one dialect per instance, never dual writes). Runs the same
dialect-agnostic contract suite as the SQLite plugin (`@bee-agent/storage/testing`).

- `PostgresStorage` — pooled connections plus a `TransactionManager` that checks
  out a client per transaction and routes `query()` calls onto it via
  `AsyncLocalStorage`, so statements issued inside a transaction join it without
  threading a client through the contract.
- `PostgresEventStore` — append-only events with atomic per-task sequence
  allocation (`INSERT … ON CONFLICT … DO UPDATE … RETURNING`), replay from a
  checkpoint, and oldest-first `listTaskIds()` backed by an identity column.
- `PostgresStoragePlugin` — Cordis plugin wrapper registering both under the
  standard `event-store` / `storage` service keys.

## Running the integration tests

The suite needs a real PostgreSQL and skips when the URL is absent:

```bash
docker run -d --name bee-agent-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=bee_agent \
  -p 127.0.0.1:5432:5432 pgvector/pgvector:pg17

BEE_AGENT_STORAGE_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/bee_agent \
  pnpm --filter @bee-agent/plugin-storage-postgres test
```
