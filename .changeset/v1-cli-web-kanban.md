---
'@bee-agent/web': minor
'@bee-agent/cli': minor
---

Land the CLI/Web Kanban views (v1 refactor plan §5.2 P2-9).

- `@bee-agent/web`: a `KanbanBoard` view (list, create, complete, cancel with status badges) plus a Chat/Board toggle in the app shell, reading and writing the same store the conversation uses.
- `@bee-agent/cli`: the `kanban` command group now covers create/list/show/update/block/comment/complete/cancel.
