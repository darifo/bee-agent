# @bee-agent/kanban

## 0.2.0

### Minor Changes

- 84e646b: Land the Kanban API and agent tools (v1 refactor plan §5.2 P2-3).

  - `@bee-agent/kanban` adds `update` (a field-only mutation) and `comment` operations with the `kanban.task.updated` / `kanban.task.commented` events and a `comments` field folded into the projection, plus the eight lazy-loadable `kanban_*` tool definitions and `createKanbanToolExecutor` — the one store the REST API, agent tools, CLI, Web, and Scheduler all share.
  - `@bee-agent/bee` wires a `KanbanStore` into the host: `/kanban/tasks` REST endpoints (create/list/show/update/block/comment/complete/cancel) and a composite tool slot that routes `kanban_*` calls to the store while exposing the tool specs to the model; `main.ts` recovers the board from SQLite on startup (`rebuild`).
  - `@bee-agent/client` adds `createTask`/`listTasks`/`getTask`/`updateTask`/`blockTask`/`commentTask`/`completeTask`/`cancelTask`.
  - `@bee-agent/cli` adds a minimal `kanban create/list/show` command group.

- 8e04cd7: Land the Kanban domain model (architecture §15.2, v1 refactor plan §5.2 P2-1).

  - `KanbanTask` zod contract with the full field set: goal/acceptance criteria, priority, labels, dependencies (`blocks`/`related` with a `satisfiedWhen` status), source Thread/Turn, workspace, required capabilities, resource budget, `scheduledAt`/`deadline`, idempotency key, claim lease, and artifact/trajectory references, plus the `version`/timestamps the aggregate needs.
  - The state machine table (`inbox → triaged → ready → running → blocked/review → done`, with `failed`/`cancelled`/`archived` reachable from every active state, retry from `failed`, and archive of terminal states) as pure `canTransition`/`allowedTransitions` helpers plus `applyTransition`, which bumps `version`, stamps `endedAt` on terminal entry, and clears the claim lease when leaving `running`.
  - Expected-version concurrency: `applyTransition` throws `KanbanVersionConflictError` when the caller's `expectedVersion` no longer matches, and `KanbanInvalidTransitionError` for illegal transitions — distinct from the Chronicle stream-level sequence conflict.
  - Chronicle wiring: `kanban.task.created` and `kanban.task.status_changed` event types registered on a `ChronicleSchemaRegistry`, event builders, a `kanban:<id>` stream convention, and `appendKanbanTaskEvents` for expected-sequence appends over any `ChronicleStore`. The store contract and dispatcher land in P2-2.

- 40988a8: Land the Kanban store and dispatcher (v1 refactor plan §5.2 P2-2).

  - `KanbanStore` contract plus `ChronicleKanbanStore`: a queryable projection kept in sync with the Chronicle event log and rebuilt from it via `rebuild()`, so a Host restart recovers the board with no in-memory state. Writes are guarded twice — the aggregate `version` and, underneath, the stream `sequence`, which is now tied to the version (created = version 1/sequence 1, every mutation advances both) so two concurrent writers on one task can never both succeed.
  - `kanban.task.lease_renewed` event plus claim/lease support: `transition` can attach a claim lease when entering `running`, `renewLease` extends it with fencing on the lease id, and leaving `running` releases it. The state machine gains `running → ready` for lease expiry and worker release.
  - `KanbanDispatcher`: priority/deadline/schedule-ordered `readyTasks`, dependency-aware eligibility, `claimNext` with per-worker backpressure, `heartbeat`, `reclaimExpired` (timeout reclaim), and `complete`/`fail`/`block`/`cancel` guarded by lease ownership.
  - `@bee-agent/kanban/testing` ships `MemoryKanbanStore` and the dialect-agnostic `defineKanbanStoreContractSuite` (create/idempotency, expected-version, claim/lease/fencing, list ordering, rebuild).
  - `@bee-agent/storage-sqlite` gains `SQLiteKanbanStore` — the same store over `SQLiteChronicleStore`, durable across reopen.

- bedbda4: Link Kanban tasks and Threads bidirectionally (v1 refactor plan §5.2 P2-4).

  - `KanbanSource` gains `itemId` (the originating tool_call item), so a task points at its Thread, Turn, and originating Item in one hop; artifact and trajectory references stay on the task for the Episode/Artifact direction.
  - `KanbanStore.list` gains `sourceThreadId` / `sourceItemId` filters, so a Thread or Item resolves back to its tasks in one hop — no multi-hop joins.
  - The kanban tool executor accepts a `context` (`threadId`/`turnId`/`itemId`) and `kanban_create` records it as the task's `source`; `AgentLoopToolSlotCall` now carries the tool_call `itemId`, and the host wires that context through to the executor.

- 7460bb1: Scaffolded the six new v1 core packages (ADR 0018, refactor plan §3.1) as empty skeletons: package boundary, exports, build/typecheck/test wiring, and a documented placeholder for the public surface.

  - `@bee-agent/thread` will carry the Thread–Turn–Item interaction protocol (Phase 1).
  - `@bee-agent/kanban` will carry the durable task plane: model, state machine, store contracts, claim/lease, dispatcher (Phase 2).
  - `@bee-agent/context` will carry prompt sections, context budgets, compression, the Skill registry, and tool index/resolver (Phase 2).
  - `@bee-agent/knowledge` will carry the Chronicle envelope, ChronicleStore contracts, world/structure projections, and memory provider contracts (Phase 1+).
  - `@bee-agent/execution` will carry the capability pipeline, permissions, approvals, secret brokering, ExecutionWorld/sandbox, and artifact contracts (Phase 3).
  - `@bee-agent/learning` will carry derivers, consolidators, skill learning, proposals, experiments, and evaluation (Phase 5).

### Patch Changes

- Updated dependencies [34d0d4f]
- Updated dependencies [6c62bd0]
- Updated dependencies [e359897]
- Updated dependencies [7460bb1]
- Updated dependencies [149fddf]
  - @bee-agent/knowledge@0.2.0
