# ADR 0033: Make ModelRequest a durable plugin boundary

- Status: Accepted and implemented
- Date: 2026-08-25

## Context

`AgentLoop` previously called `LlmRuntime.generate()` directly. Although `ContextManifest` types and events existed, they were not coupled to real model calls. A checkpoint also retained only assistant text and tool output objects, so tool intents and exact model-visible tool results could drift during crash recovery.

## Decision

Introduce a tier-B `ModelRequestService` plugin between `AgentLoop` and `LlmRuntime`. Every attempt owns one `model-request:<requestId>` Chronicle stream. Before provider execution it atomically appends `context.manifest` and `model.requested`; settlement appends exactly one `model.completed` or `model.failed` event.

`model.requested` retains canonical section source snapshots and a digest of the complete `ContextBundle`. Historical reconstruction runs the recorded renderer version over each source, checks every manifest section digest, rebuilds messages/tools/decision schema, and checks the complete bundle digest.

Checkpoint recovery persists assistant tool calls and exact tool result `content`/`isError`. It treats the checkpoint `stepIndex` as the next step, recomputes `stateDigest`, and records `agent.recovery_failed` before throwing when the digest differs.

## Consequences

- `AgentLoop` depends on `modelRequest`, not `llm`; provider replacement and context policy changes remount the model boundary through the generation graph.
- Every provider attempt, including retries and failures, is independently auditable.
- Exact recovery costs additional Chronicle storage for canonical source snapshots. Retention and encryption policies must treat these streams as model-visible user data.
- Context budgeting can evolve behind `ModelRequestService` without changing provider adapters or the loop state machine.
