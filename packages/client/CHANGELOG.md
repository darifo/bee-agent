# @bee-agent/client

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
