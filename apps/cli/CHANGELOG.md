# @bee-agent/cli

## 1.0.0

### Major Changes

- ad42a4d: Rewrite the CLI as a conversation client. `bee chat` starts an interactive thread and keeps turning user messages into turns, resolving approval prompts inline; `bee thread create` creates a thread. The v0 task/approval/memory command groups are removed.

### Minor Changes

- 8b47e1b: Land the CLI/Web Kanban views (v1 refactor plan §5.2 P2-9).

  - `@bee-agent/web`: a `KanbanBoard` view (list, create, complete, cancel with status badges) plus a Chat/Board toggle in the app shell, reading and writing the same store the conversation uses.
  - `@bee-agent/cli`: the `kanban` command group now covers create/list/show/update/block/comment/complete/cancel.

- 84e646b: Land the Kanban API and agent tools (v1 refactor plan §5.2 P2-3).

  - `@bee-agent/kanban` adds `update` (a field-only mutation) and `comment` operations with the `kanban.task.updated` / `kanban.task.commented` events and a `comments` field folded into the projection, plus the eight lazy-loadable `kanban_*` tool definitions and `createKanbanToolExecutor` — the one store the REST API, agent tools, CLI, Web, and Scheduler all share.
  - `@bee-agent/bee` wires a `KanbanStore` into the host: `/kanban/tasks` REST endpoints (create/list/show/update/block/comment/complete/cancel) and a composite tool slot that routes `kanban_*` calls to the store while exposing the tool specs to the model; `main.ts` recovers the board from SQLite on startup (`rebuild`).
  - `@bee-agent/client` adds `createTask`/`listTasks`/`getTask`/`updateTask`/`blockTask`/`commentTask`/`completeTask`/`cancelTask`.
  - `@bee-agent/cli` adds a minimal `kanban create/list/show` command group.

### Patch Changes

- Updated dependencies [b1a48bf]
- Updated dependencies [b1a48bf]
- Updated dependencies [ad42a4d]
- Updated dependencies [84e646b]
- Updated dependencies [7460bb1]
- Updated dependencies [85be532]
- Updated dependencies [de9f3f4]
- Updated dependencies [1c6c976]
  - @bee-agent/thread@0.2.0
  - @bee-agent/client@1.0.0
