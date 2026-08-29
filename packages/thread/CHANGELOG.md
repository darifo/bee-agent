# @bee-agent/thread

## 0.2.0

### Minor Changes

- b1a48bf: Hardened the model interaction boundary of the AgentLoop (P0 of the benchmark-driven hardening pass).

  - `@bee-agent/model-providers`: `OpenAIChatRuntime` now streams for real — `stream: true` + `stream_options.include_usage`, SSE parsing that pushes `message-delta` events as chunks arrive, tool intents assembled from streamed argument fragments, and a buffered-JSON fallback when a provider or proxy answers without `text/event-stream` (or `streaming: false` is set). Request timeouts cover headers only, so long streams are not killed mid-flight. `Retry-After` is parsed into `LlmRuntimeError.retryAfterMs`, and malformed tool arguments are surfaced as `inputError` on the call instead of silently executing with `{}`.
  - `@bee-agent/runtime` (AgentLoop): retries back off (Retry-After, then exponential, cap 30s) instead of hammering the provider; message deltas are buffered before hitting Chronicle (256-char flush) so real streaming does not become one write per chunk; a throwing tool or malformed-arguments call is isolated as an `isError` tool result the model can react to instead of failing the turn — recorded as `item.completed` so checkpoint digests stay rebuildable; `max_tokens` doubles the output cap (bounded by the model maximum) and regenerates the step, and only fails with a clear error when the maximum is already reached. `ModelRequestService.capabilities()` exposes the bound model's limits to the loop.
  - `@bee-agent/thread`: tool-call payloads and assistant `toolCalls` carry an optional `inputError` for provider-detected malformed arguments.

- b1a48bf: Thread conversation continuity and level-2 context compaction (benchmark-driven hardening pass, steps 7–8): a thread now behaves as one conversation, and that conversation survives its own growth.

  - **Continuity** (`@bee-agent/runtime`): `runTurn` reconstructs the thread's prior turns — completed messages and tool calls across all turns, in sequence order — and precedes the new input with them (`carryThreadHistory: false` opts out). Crash recovery rebuilds the same construction: the carried prefix (events before this turn started) plus the turn's committed items, so checkpoint digests stay verifiable with carry in play — verified by a recovery test whose second turn resumes with the full thread in view. The CLI chat and HTTP API inherit continuity without changes.
  - **Level-2 compaction**: when the model-visible request exceeds a threshold (default 70% of the model's context window), the AgentLoop summarizes the covered history prefix with one durable, tool-free model call and records a `context.compacted` event (`@bee-agent/thread`): summary, covered message count, sha256 over the covered prefix, and its token estimate. The projection then folds that prefix into a single summary message (`Summary of the earlier conversation (N messages): …`) while Chronicle keeps the full history untouched — the same fold-the-view-never-the-log discipline as level 1. The covered digest is re-verified on every fold and on reload; a summary that does not describe the current prefix is inapplicable, not wrong. Per-turn attempt budget (default 2) breaks failing summarizer loops — the Claude Code lesson — and a failed attempt proceeds unfolded so overflow surfaces honestly.
  - Tunables via `AgentLoopOptions.contextCompaction` (threshold, recent window, attempts, minimum covered messages). Covered by continuity/compaction/breaker/recovery tests and two recorded replay fixtures (`thread-continuity`, `context-compaction`) pinning the carried message order, the summarizer request shape, the folded view, and the durable `context.compacted` event.

- 7460bb1: Scaffolded the six new v1 core packages (ADR 0018, refactor plan §3.1) as empty skeletons: package boundary, exports, build/typecheck/test wiring, and a documented placeholder for the public surface.

  - `@bee-agent/thread` will carry the Thread–Turn–Item interaction protocol (Phase 1).
  - `@bee-agent/kanban` will carry the durable task plane: model, state machine, store contracts, claim/lease, dispatcher (Phase 2).
  - `@bee-agent/context` will carry prompt sections, context budgets, compression, the Skill registry, and tool index/resolver (Phase 2).
  - `@bee-agent/knowledge` will carry the Chronicle envelope, ChronicleStore contracts, world/structure projections, and memory provider contracts (Phase 1+).
  - `@bee-agent/execution` will carry the capability pipeline, permissions, approvals, secret brokering, ExecutionWorld/sandbox, and artifact contracts (Phase 3).
  - `@bee-agent/learning` will carry derivers, consolidators, skill learning, proposals, experiments, and evaluation (Phase 5).

- 85be532: Add loop-authored events to the Thread–Turn–Item protocol: `agent.checkpoint` (stepIndex plus a state digest, marking that every step effect before it is durable) and `turn.cancelled`. The approval item payload also gains optional `approvalId`/`callId`/`toolId` so a suspended turn's pending tool call can be recovered durably after a crash.
- de9f3f4: Land the Thread–Turn–Item protocol and its Chronicle integration. `@bee-agent/thread/protocol` is the dependency-free client surface (zod only, no cordis): Thread/Turn/Item zod contracts with the architecture's eight item types (message, plan, tool call, approval, artifact, file change, memory citation, learning note) paired to their payloads by a discriminated union, plus the wire event union (`thread.created`, `turn.started/completed/failed`, `item.started/delta/completed/failed`) and page types. The package root adds model constructors, Chronicle event builders (scope ids and turn structureVersion on the envelope), a `thread:<id>` stream convention, and `readThreadEvents` implementing `after` recovery with limit paging over any ChronicleStore — sequences are contiguous per thread, so reconnecting clients resume from their last seen sequence without gaps.
- 1c6c976: Export `threadEventFromChronicle` so hosts can convert one stored Chronicle event into its wire shape for live SSE streaming, without re-reading the whole stream.

### Patch Changes

- Updated dependencies [34d0d4f]
- Updated dependencies [6c62bd0]
- Updated dependencies [e359897]
- Updated dependencies [7460bb1]
- Updated dependencies [149fddf]
  - @bee-agent/knowledge@0.2.0
