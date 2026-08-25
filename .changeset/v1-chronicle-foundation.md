---
'@bee-agent/kernel': minor
'@bee-agent/knowledge': minor
'@bee-agent/execution': minor
'@bee-agent/plugin-storage-sqlite': minor
---

Landed the Chronicle foundation of Phase 1 (v1 refactor plan §5.2: kernel event modes, Chronicle envelope/registry/store contract, SQLite adapter, ArtifactStore).

- Kernel event bus gained `emit` (broadcast with per-listener error isolation routed to an optional `onError`; never rejects) and `parallel` (concurrent listeners, `AggregateError` with every failure in registration order) alongside serial and waterfall; one listener registry per event name with the execution semantic chosen at the call site (ADR 0018 four event modes).
- `@bee-agent/knowledge` now defines the Chronicle event envelope (dual-time `eventTime`/`ingestTime`/`validTime`, scope ids, actor, causation/correlation/parent links, world/structure/policy versions, classification + retention) with strict Zod schemas and a `newChronicleEvent` producer helper; the `ChronicleSchemaRegistry` fails loud on unknown event types for both append and replay, with explicit `ignorable` skips; the `ChronicleStore` contract covers `(streamId, sequence)` uniqueness, mandatory `expectedSequence` appends, and idempotent retries (same event ids at the same position return the stored rows).
- `@bee-agent/knowledge/testing` ships `MemoryChronicleStore` plus the dialect-agnostic `defineChronicleStoreContractSuite` (sequence allocation, optimistic concurrency, idempotency, registry enforcement, pagination, stream listing).
- `@bee-agent/plugin-storage-sqlite` gained `SQLiteChronicleStore` — the default embedded v1 store: sequence allocation and inserts share one transaction, retries replay from the stored window, and reads round-trip through the stored envelope. Runs the shared contract suite plus reopen-persistence and shared-handle dialect tests.
- `@bee-agent/execution` gained the content-addressed `ArtifactStore` contract with `LocalArtifactStore` (sha256, two-hex sharding, atomic temp-file writes, dedup) so Chronicle events can carry digest references instead of large payloads.
