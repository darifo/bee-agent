---
'@bee-agent/contracts': patch
'@bee-agent/runtime': minor
'@bee-agent/client': minor
'@bee-agent/server': minor
'@bee-agent/cli': minor
---

Added the HTTP/SSE server, Client SDK, and CLI.

- `@bee-agent/server`: Fastify composition root that starts the kernel, mounts the SQLite storage plugin under the standard `event-store`/`storage` service keys, wires the task runtime (mock agent + calculator tool), and serves the ADR 0010 API: task create/get/run/cancel, event listing, pending-approval listing and decisions, and an SSE channel that replays recorded events after `Last-Event-ID` (or `?after=`) and then streams live events, closing at terminal states with heartbeats in between. Errors map to the shared envelope (404 unknown ids, 409 invalid state or concurrent run, 400 validation); the run route surfaces pre-start failures immediately instead of timing out.
- `@bee-agent/client`: the only supported way to reach the server (ADR 0003). REST methods for tasks/approvals plus `streamEvents`, a zero-dependency async generator that parses SSE frames (multi-line data, comments, partial chunks), resumes via `Last-Event-ID`, validates events against the contracts schema, and ends cleanly on abort signals. Client errors carry status, code, and envelope details.
- `@bee-agent/cli`: Commander-based `bee` binary with `task create/run/watch/get/events/cancel` and `approval list/decide`; `task run` streams messages, tool calls, and approval notices over SSE and exits 0/1/2 for completed/failed/cancelled.
- `@bee-agent/runtime`: `TaskRuntime.listPendingApprovals()` lists suspended approval requests (optionally task-scoped); the policy middleware is now registered once on the kernel bus so concurrent runs no longer evaluate policies once per active run.
- `@bee-agent/contracts`: `ToolResultSchema.output` (and the runtime's completed payload `result`) now tolerate keys dropped by JSON round trips — error results previously failed replay validation after storage or HTTP serialization.
