# ADR 0020: Use Chronicle as the Temporal Source of Truth

## Background

v0 kept an `EventStore` with a per-task sequence and a separate `VectorStore` for memory, and its runtime held approval state in an in-memory map that reset on restart. The v1 architecture (§8.2, §9.1) requires foreground recovery to depend only on durable facts, so a crashed Turn must resume from what was already recorded rather than from RAM.

## Decision

The Chronicle event log is the single temporal source of truth for every durable fact in v1. All events flow through one envelope: a `(streamId, sequence)` position assigned atomically by the store, dual-time fields (`eventTime`/`ingestTime`/`validTime`), scope ids (thread/turn/goal/plan/episode/step), actor, causation/correlation/parent ids, world/structure/policy versions, classification, and retention class. The `ChronicleStore` contract enforces optimistic concurrency via a mandatory `expectedSequence` and makes retried appends idempotent. Thread events, resolved `EffectiveStructure`s, and ContextManifests are all Chronicle events; the SQLite `ChronicleStore` is the default implementation, with the contract-suite pattern (`defineChronicleStoreContractSuite`) testing every adapter.

## Reasons

Durability and replay are the price of cross-time work and recovery: a Turn, a Kanban Task, and a learning run must each be reconstructable from the log alone. A single envelope and store contract keep every subsystem honest about ordering, provenance, and retention, and the schema registry fails loud on unknown event types instead of silently dropping them.

## Alternatives

Keep a task-scoped event store plus a separate memory store (two sources of truth drift apart, and recovery spans two systems); rely on in-memory runtime state (reset on restart, as v0's approval map did); or an unversioned append-only log (no optimistic concurrency, so concurrent writers silently interleave).

## Positive impact

Crash recovery (`AgentLoop.recoverTurn`) rebuilds committed history from Chronicle plus the last checkpoint; structure changes are queryable, comparable, and recoverable as `structure.resolved` events; token/omission cost is auditable from persisted ContextManifests.

## Negative impact

Every durable write pays envelope + schema-validation overhead, and retention/compaction becomes a first-class concern that cannot be deferred forever.

## Follow-up constraints

No subsystem may persist durable facts outside Chronicle; schema types must be registered before use and unknown types fail loud on both write and replay; retention classification is set per event type, and the `ignorable` replay skip is explicit, never silent.
