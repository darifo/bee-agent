---
'@bee-agent/runtime': minor
'@bee-agent/plugin-tool-calculator': minor
---

Added the core runtimes layer.

- `@bee-agent/runtime` introduces the task runtime: an explicit task state machine (`pending → running → waiting_approval/completed/failed/cancelled`), a canonical lifecycle event taxonomy whose payloads carry the resulting state, and a fold-based reducer that rebuilds `TaskSnapshot`s from the Event Store and rejects illegal replays.
- `TaskRuntime` creates tasks, runs agents inside kernel task scopes, appends every step as events, cancels cooperatively, and resolves with the final snapshot so task outcomes are data rather than exceptions. It dispatches `task/event-recorded` on the kernel bus after every append and resolves its Event Store through the `event-store` kernel service (with an inline override for tests).
- Agent contract (`Agent`, `AgentRunContext`) with cancellation checks, custom non-reserved events, and tool invocation; `MockAgent` executes deterministic `say`/`tool`/`fail` scripts and doubles as the reference implementation.
- Tool pipeline: `Tool`/`ToolRegistry` with per-run isolated clones and a `tools/execute` waterfall that middleware can intercept; tool failures surface as tool result errors while the task keeps running.
- Policy engine: ordered policies returning `allow`, `deny`, or `approval` (with risk and optional expiry); approval requests suspend the task (`waiting_approval`) until `resolveApproval` decides, denial becomes a tool result error, and expired approvals resolve as denied. Ships `createToolAllowlistPolicy` and `createToolApprovalPolicy`.
- `@bee-agent/plugin-tool-calculator` provides the reference capability plugin: a safe recursive-descent arithmetic evaluator (no `eval`) exposed as a Bee Agent plugin with a valid manifest.
