---
'@bee-agent/kanban': minor
'@bee-agent/runtime': minor
'@bee-agent/bee': minor
---

Link Kanban tasks and Threads bidirectionally (v1 refactor plan §5.2 P2-4).

- `KanbanSource` gains `itemId` (the originating tool_call item), so a task points at its Thread, Turn, and originating Item in one hop; artifact and trajectory references stay on the task for the Episode/Artifact direction.
- `KanbanStore.list` gains `sourceThreadId` / `sourceItemId` filters, so a Thread or Item resolves back to its tasks in one hop — no multi-hop joins.
- The kanban tool executor accepts a `context` (`threadId`/`turnId`/`itemId`) and `kanban_create` records it as the task's `source`; `AgentLoopToolSlotCall` now carries the tool_call `itemId`, and the host wires that context through to the executor.
