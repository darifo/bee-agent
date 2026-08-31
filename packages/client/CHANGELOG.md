# @bee-agent/client

## 1.1.0

### Minor Changes

- 93373c4: Phase 6 first slice: `bee doctor` and CLI governance over the new
  capability surfaces. A new `GET /diagnostics` endpoint summarizes every
  subsystem in one call — overall status, structure (active version, restart
  requirements, kernel doctor, config source), memory (health plus claim
  counts), world projection, scheduler, learning (proposals by status, loop
  and drift budgets), and thread count — degrading to `degraded` when memory
  is unavailable and never letting a provider outage fail the probe. The
  client SDK gains diagnostics plus the memory-governance
  (list/forget/consolidate) and learning-governance (run/list/show/experiment/
  transition/monitor) method families. The CLI adds `bee doctor`,
  `bee memory list|forget|consolidate`, and the full `bee learning`
  lifecycle (run/list/show/experiment/review/trial/promote/reject/rollback/
  monitor) — the governance arc from Phase 5 is now operable without curl.
- 76dc6ca: Phase 6 WF6-C: the v0 → v1 import tool. `POST /import/v0` (and `bee import
<path>`) reads a v0 SQLite event store read-only and converts each v0 task
  into one v1 Chronicle thread: task input becomes the user message, agent
  messages become message items, tool traffic becomes tool_call items with
  callId-correlated results and isError, approvals become approval items
  carrying the decision, and the terminal task state becomes the matching
  turn event. Every produced event carries `v0-import` provenance; the v0
  task id doubles as the thread id so re-running skips already-imported
  threads and reports them. Missing databases are a clean 404.
- 9db8e4c: Phase 6 WF6-B: governance views in the web console. A Memory panel lists
  what Bee remembers with status badges and one-click Forget (backed by the
  durable retraction) plus Consolidate; a Learning panel runs the slow loop,
  fires the isolated experiment, and drives the full governance lifecycle
  (review → trial → promote → rollback) over the same routes the CLI uses,
  with drift checks on demand. The client SDK exports the Diagnostics,
  MemoryClaimDto, LearningProposalDto, and LearningTransitionInput types the
  views consume. The Phase 5 governance arc is now operable from chat, CLI,
  and browser alike.

## 1.0.0

### Major Changes

- ad42a4d: Rewrite the client SDK against the Personal Bee Host's `/threads` API. `createThread` creates a thread, `createTurn` starts a turn, `resolveApproval` resumes a suspended turn, and `streamItems` streams wire thread events over SSE with `Last-Event-ID` recovery. The SDK now depends only on the dependency-free `@bee-agent/thread/protocol` surface (plus zod), so browser clients no longer pull the Chronicle/kernel node builtins. The v0 task/approval/memory methods are gone.

### Minor Changes

- 84e646b: Land the Kanban API and agent tools (v1 refactor plan §5.2 P2-3).

  - `@bee-agent/kanban` adds `update` (a field-only mutation) and `comment` operations with the `kanban.task.updated` / `kanban.task.commented` events and a `comments` field folded into the projection, plus the eight lazy-loadable `kanban_*` tool definitions and `createKanbanToolExecutor` — the one store the REST API, agent tools, CLI, Web, and Scheduler all share.
  - `@bee-agent/bee` wires a `KanbanStore` into the host: `/kanban/tasks` REST endpoints (create/list/show/update/block/comment/complete/cancel) and a composite tool slot that routes `kanban_*` calls to the store while exposing the tool specs to the model; `main.ts` recovers the board from SQLite on startup (`rebuild`).
  - `@bee-agent/client` adds `createTask`/`listTasks`/`getTask`/`updateTask`/`blockTask`/`commentTask`/`completeTask`/`cancelTask`.
  - `@bee-agent/cli` adds a minimal `kanban create/list/show` command group.

### Patch Changes

- Updated dependencies [b1a48bf]
- Updated dependencies [b1a48bf]
- Updated dependencies [7460bb1]
- Updated dependencies [85be532]
- Updated dependencies [de9f3f4]
- Updated dependencies [1c6c976]
  - @bee-agent/thread@0.2.0
