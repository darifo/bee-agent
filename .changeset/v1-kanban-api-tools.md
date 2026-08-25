---
'@bee-agent/kanban': minor
'@bee-agent/bee': minor
'@bee-agent/client': minor
'@bee-agent/cli': minor
---

Land the Kanban API and agent tools (v1 refactor plan §5.2 P2-3).

- `@bee-agent/kanban` adds `update` (a field-only mutation) and `comment` operations with the `kanban.task.updated` / `kanban.task.commented` events and a `comments` field folded into the projection, plus the eight lazy-loadable `kanban_*` tool definitions and `createKanbanToolExecutor` — the one store the REST API, agent tools, CLI, Web, and Scheduler all share.
- `@bee-agent/bee` wires a `KanbanStore` into the host: `/kanban/tasks` REST endpoints (create/list/show/update/block/comment/complete/cancel) and a composite tool slot that routes `kanban_*` calls to the store while exposing the tool specs to the model; `main.ts` recovers the board from SQLite on startup (`rebuild`).
- `@bee-agent/client` adds `createTask`/`listTasks`/`getTask`/`updateTask`/`blockTask`/`commentTask`/`completeTask`/`cancelTask`.
- `@bee-agent/cli` adds a minimal `kanban create/list/show` command group.
