# ADR 0009: Define the task runtime state machine and event taxonomy

## Background

The kernel, contracts, and Event Store exist, but nothing yet executes tasks. Task execution needs an explicit state machine and a canonical event taxonomy so every snapshot stays derivable from the event stream (ADR 0002).

## Decision

Adopt a strict task state machine and a lifecycle event taxonomy in `@bee-agent/runtime`:

- Transitions: `pending → running | cancelled`, `running → waiting_approval | completed | failed | cancelled`, `waiting_approval → running | failed | cancelled`; `completed`, `failed`, and `cancelled` are terminal.
- Every lifecycle event (`task.created`, `task.started`, `task.suspended`, `task.resumed`, `task.completed`, `task.failed`, `task.cancelled`) carries the resulting `state` in its payload; snapshots are rebuilt by folding events (`reduceTaskSnapshot`) and the reducer rejects illegal transitions, sequence gaps, and a non-initial `task.created` during replay.
- Tool calls flow through a `tools/execute` waterfall on the task scope's event bus. Policy middleware decides `allow`, `deny`, or `approval` (with risk and optional expiry); denials become tool result errors, not task failures.
- Approval suspends the task: `approval.requested` + `task.suspended` are appended, then `approval.decided` + `task.resumed` on decision. Expired approvals resolve as denied at decision time.
- Task outcomes are data: `run()` resolves with the final snapshot instead of throwing agent failures; cancellation is cooperative between agent steps and appends `task.cancelled` immediately.

## Reasons

One state machine plus a fold-based reducer keeps execution inspectable, replayable, and restart-safe while policies, approvals, and observability hang off a single interception point.

## Alternatives

Mutable task rows updated in place; state inferred loosely from arbitrary events; approvals modeled as task failures.

## Positive impact

Snapshots survive runtime restarts; the future SSE layer can stream recorded events; policy and approval behavior is testable without a server.

## Negative impact

The runtime reserves lifecycle, approval, and tool event types for itself, and the reducer enforces strict sequence contiguity, so external writers must follow the same discipline.

## Follow-up constraints

Agents cannot emit runtime-reserved event types; lifecycle appends are serialized per task; resume of a crashed `running` task from a checkpoint is deferred until the server stage.
