---
'@bee-agent/kanban': minor
'@bee-agent/storage-sqlite': minor
---

Land the Kanban store and dispatcher (v1 refactor plan §5.2 P2-2).

- `KanbanStore` contract plus `ChronicleKanbanStore`: a queryable projection kept in sync with the Chronicle event log and rebuilt from it via `rebuild()`, so a Host restart recovers the board with no in-memory state. Writes are guarded twice — the aggregate `version` and, underneath, the stream `sequence`, which is now tied to the version (created = version 1/sequence 1, every mutation advances both) so two concurrent writers on one task can never both succeed.
- `kanban.task.lease_renewed` event plus claim/lease support: `transition` can attach a claim lease when entering `running`, `renewLease` extends it with fencing on the lease id, and leaving `running` releases it. The state machine gains `running → ready` for lease expiry and worker release.
- `KanbanDispatcher`: priority/deadline/schedule-ordered `readyTasks`, dependency-aware eligibility, `claimNext` with per-worker backpressure, `heartbeat`, `reclaimExpired` (timeout reclaim), and `complete`/`fail`/`block`/`cancel` guarded by lease ownership.
- `@bee-agent/kanban/testing` ships `MemoryKanbanStore` and the dialect-agnostic `defineKanbanStoreContractSuite` (create/idempotency, expected-version, claim/lease/fencing, list ordering, rebuild).
- `@bee-agent/storage-sqlite` gains `SQLiteKanbanStore` — the same store over `SQLiteChronicleStore`, durable across reopen.
