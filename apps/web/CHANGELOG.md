# @bee-agent/web

## 1.0.0

### Major Changes

- ad42a4d: Rewrite the web client as a single conversation view driven by the item stream: a thread's SSE stream is reduced into transcript entries (user/assistant/tool/approval) and suspended turns surface an inline approval prompt. The v0 task console components are removed.

### Minor Changes

- 8b47e1b: Land the CLI/Web Kanban views (v1 refactor plan §5.2 P2-9).

  - `@bee-agent/web`: a `KanbanBoard` view (list, create, complete, cancel with status badges) plus a Chat/Board toggle in the app shell, reading and writing the same store the conversation uses.
  - `@bee-agent/cli`: the `kanban` command group now covers create/list/show/update/block/comment/complete/cancel.

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
