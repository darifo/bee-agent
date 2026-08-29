# @bee-agent/runtime

## 1.0.0

### Major Changes

- 066bd78: Remove the v0 task runtime: `TaskRuntime`, `task-events`, `task-state-machine`, `MockAgent`, `MemoryRuntime`, and their `Agent`/`Tool`/`ToolRegistry`/`ToolPolicy`/`Embedder`/`memory-chunker` infrastructure are deleted. The runtime package now exposes only the v1 `AgentLoop` and `LlmRuntime` surface.

### Minor Changes

- b1a48bf: Context compaction, level 1: old tool results are elided from the model-visible request under a token budget (benchmark-driven hardening pass, step 4).

  - New `context-policy` module: `projectHistory(history, policy)` folds the model view — tool results beyond `toolResultBudgetTokens` (default 4096) and outside the `keepRecentToolResults` window (default 4) become a deterministic placeholder carrying the original token count, tool id, and content digest. Error results are protected (failure reasons are what the model must still see), as is the recent window where the model is working. The projection is pure: `state.history` keeps full fidelity, checkpoint digests keep rebuilding from Chronicle unchanged, and recovery re-derives the same view deterministically (the dsh surface-fold approach — fold the view, never the log).
  - The AgentLoop applies the projection to every assembled request; `ModelRequestService` records each elision as a manifest omission (`context-policy:tool-result-budget`), so the existing request-replay audit shows exactly what the model stopped seeing and why.
  - Tunable per loop via `AgentLoopOptions.toolResultCompaction`; exported as `DEFAULT_TOOL_RESULT_COMPACTION` / `projectHistory` for host wiring. Covered by unit tests, an AgentLoop integration test (Chronicle keeps full content while the model sees placeholders), and a recorded replay fixture pinning the elision progression across a multi-tool session.

- a2540a2: Add the durable agent scheduler (Phase 4 WF4-F core): one-shot and recurring
  triggers that continue a bound thread across days and restarts. Trigger state
  lives on a serialized `scheduler` Chronicle stream (registered/triggered/
  removed events) and rebuilds on restart; ticks fire due triggers under a
  fire-once catch-up policy that collapses missed intervals into one run —
  reporting how many were skipped and resuming on the original cadence. Turns
  launched by the scheduler are marked with trigger `schedule`, and a crashing
  turn still advances the schedule (no hot loops). The Host enables the
  scheduler by default (5s auto-tick) and exposes `/scheduler/triggers` CRUD
  plus a manual `POST /scheduler/tick`.
- 34d0d4f: Add the Phase 4 personal memory foundation: the MemoryProvider contract with
  Claim/Observation/Representation schemas and a Chronicle-backed contract suite
  in knowledge; the embedded `memory-bee` provider (durable `memory` stream
  projection, lexical recall with CJK bigrams, deterministic preference/correction
  derivation, duplicate consolidation); AgentLoop retrieve-hook recall and a
  near-line derivation worker in runtime; and Host wiring with memory governance
  routes (`GET /memory/claims`, `POST /memory/claims/:id/retract`,
  `POST /memory/consolidate`, `GET /memory/export`), the Goal/Plan hook, and
  optional `BEE_AGENT_STRUCTURE_FILE` hot reload.
- 6c62bd0: Add explicit remote-memory degradation: a `memory.health.changed` Chronicle
  event records every provider health transition; `MemoryProviderUnavailableError`
  enables fail-fast calls; the new `@bee-agent/memory-remote` package provides
  the bridge transport seam (with an in-process SDK bridge) and
  `RemoteMemoryProvider` with a consecutive-failure circuit breaker whose
  recovery runs through health probes. The recall hook now skips gracefully when
  a circuit opens mid-call. Phase 4 CI gates land with this slice: conflicting
  claims stay visible until corrected, a reference in-memory provider
  self-validates the contract suite, and a fake-clock test covers weeks-later
  recall with corrections and expired valid-time facts.
- b1a48bf: Hardened the model interaction boundary of the AgentLoop (P0 of the benchmark-driven hardening pass).

  - `@bee-agent/model-providers`: `OpenAIChatRuntime` now streams for real — `stream: true` + `stream_options.include_usage`, SSE parsing that pushes `message-delta` events as chunks arrive, tool intents assembled from streamed argument fragments, and a buffered-JSON fallback when a provider or proxy answers without `text/event-stream` (or `streaming: false` is set). Request timeouts cover headers only, so long streams are not killed mid-flight. `Retry-After` is parsed into `LlmRuntimeError.retryAfterMs`, and malformed tool arguments are surfaced as `inputError` on the call instead of silently executing with `{}`.
  - `@bee-agent/runtime` (AgentLoop): retries back off (Retry-After, then exponential, cap 30s) instead of hammering the provider; message deltas are buffered before hitting Chronicle (256-char flush) so real streaming does not become one write per chunk; a throwing tool or malformed-arguments call is isolated as an `isError` tool result the model can react to instead of failing the turn — recorded as `item.completed` so checkpoint digests stay rebuildable; `max_tokens` doubles the output cap (bounded by the model maximum) and regenerates the step, and only fails with a clear error when the maximum is already reached. `ModelRequestService.capabilities()` exposes the bound model's limits to the loop.
  - `@bee-agent/thread`: tool-call payloads and assistant `toolCalls` carry an optional `inputError` for provider-detected malformed arguments.

- b1a48bf: Added the keyless recorded-session replay safety net and parallel tool dispatch with ordered commit (P1 of the benchmark-driven hardening pass).

  - `@bee-agent/runtime`: tools declare `concurrency` (`parallel` | `exclusive`, absent = exclusive, fail-closed) on `ToolExecutor`/`ToolExecutionPort`; the AgentLoop groups consecutive same-class intents into segments — parallel-safe calls dispatch as a bounded concurrent batch (`maxParallelToolCalls`, default 8) while exclusive calls and segment boundaries stay strictly ordered. Results always enter history in model order regardless of completion order, so call/output pairing survives; batch appends serialize through a write queue because Chronicle appends position themselves by the stream tail (a race the replay harness caught). A resumed or crash-recovered step now finishes tool calls its last assistant message left unexecuted (rebuilt from history and re-dispatched under the existing idempotency keys) — previously sibling calls after a suspended approval were silently dropped, leaving the model a tool-call without its result.
  - `@bee-agent/server`: the composite tool executor reports concurrency per call; `kanban_list`/`kanban_show` are parallel-safe, everything else stays exclusive until its adapter opts in.
  - Replay harness (`packages/runtime/tests/replay`): fixtures script recorded model responses and tool outcomes, the harness runs the real AgentLoop + ModelRequestService + Chronicle pipeline keylessly, and diffs turn results, the exact model-visible requests, and every Chronicle stream against the recorded expectation (uuid/timestamp normalization with stable placeholder mapping). Seven fixtures pin chat, tool round-trip, tool-error isolation, approval suspend/resume, max-tokens escalation, retry recovery, and parallel batches. Regenerate after intentional changes with `REPLAY_RECORD=1 pnpm --filter @bee-agent/runtime test`. First recordings caught and fixed a real bug: tool messages serialized `isError: undefined` into model-request sources, producing JSON that request replay could not parse.

- b1a48bf: System prompt assembly with cache discipline (benchmark-driven hardening pass, step 6): the model-visible request finally starts with a system message, and the context package's budget allocation is now on the live path.

  - `@bee-agent/runtime`: new `system-prompt` module — `SystemPromptAssembler` joins prioritized sections (identity before instructions before environment) under a token budget via the context package's `allocateContextBudget`, protects sections that must survive, and produces a digest-verified manifest plus the omitted-section ids for audit. `AgentLoopOptions.systemPrompt` takes a plain string, a lazy provider, or an assembler; the loop resolves it once (memoized) and prepends the identical system message object to every generation, so the prefix stays byte-stable for provider caching. Dynamic context keeps flowing through the retrieve/plan hooks as late messages — the documented rule is that anything per-turn belongs there, never in the system message.
  - `@bee-agent/server`: the Host ships a default Bee system prompt — identity, the declared-tool execution model, deny-by-default sandbox/approval awareness (including that a tool error is a reactable result and that resumed turns continue from recorded state), and durable-task guidance — factual to behavior that exists, overridable wholesale via `BEE_AGENT_SYSTEM_PROMPT`. The system message lands in request manifests as `instruction` sections, so request replay audits it like everything else.
  - Covered by assembler unit tests (priority join, budget omission, memoization, determinism), AgentLoop integration tests (single resolution across generations, identical message object, assembler input), a recorded replay fixture pinning the system-first message order, and updated host composition/memory-outage assertions that now expect the leading system prompt.

- b1a48bf: Thread conversation continuity and level-2 context compaction (benchmark-driven hardening pass, steps 7–8): a thread now behaves as one conversation, and that conversation survives its own growth.

  - **Continuity** (`@bee-agent/runtime`): `runTurn` reconstructs the thread's prior turns — completed messages and tool calls across all turns, in sequence order — and precedes the new input with them (`carryThreadHistory: false` opts out). Crash recovery rebuilds the same construction: the carried prefix (events before this turn started) plus the turn's committed items, so checkpoint digests stay verifiable with carry in play — verified by a recovery test whose second turn resumes with the full thread in view. The CLI chat and HTTP API inherit continuity without changes.
  - **Level-2 compaction**: when the model-visible request exceeds a threshold (default 70% of the model's context window), the AgentLoop summarizes the covered history prefix with one durable, tool-free model call and records a `context.compacted` event (`@bee-agent/thread`): summary, covered message count, sha256 over the covered prefix, and its token estimate. The projection then folds that prefix into a single summary message (`Summary of the earlier conversation (N messages): …`) while Chronicle keeps the full history untouched — the same fold-the-view-never-the-log discipline as level 1. The covered digest is re-verified on every fold and on reload; a summary that does not describe the current prefix is inapplicable, not wrong. Per-turn attempt budget (default 2) breaks failing summarizer loops — the Claude Code lesson — and a failed attempt proceeds unfolded so overflow surfaces honestly.
  - Tunables via `AgentLoopOptions.contextCompaction` (threshold, recent window, attempts, minimum covered messages). Covered by continuity/compaction/breaker/recovery tests and two recorded replay fixtures (`thread-continuity`, `context-compaction`) pinning the carried message order, the summarizer request shape, the folded view, and the durable `context.compacted` event.

- 85be532: Add the AgentLoop minimal core (architecture §10.1/§10.2). The loop owns all message state — the stateless LLMRuntime receives a fully assembled ContextBundle per call. `runTurn` runs the Act/Record loop (generate + tool execution, checkpoint after every durable step, terminal decision on end_turn/decision/max_tokens); tool execution goes through an `AgentLoopToolSlot` seam wired directly in Phase 1 and swapped for ExecutionWorld in Phase 3, and retrieval/planning are left as hook seams for Phase 2. `resumeTurn` suspends and resumes on `approval-required` outcomes, and `recoverTurn` rebuilds the committed history from Chronicle + the last `agent.checkpoint` and continues a crashed turn.
- 7cc0dd1: Add the optional Goal/Plan planning layer (v1 refactor plan §5.2 P2-5).

  - Versioned Goal/Plan DAG model (`goal-plan.ts`): a thread's `Goal` (statement, success criteria, priority, deadline, status) plus append-only `Plan` revisions whose steps form a DAG through `dependsOn`.
  - `GoalPlanStore` contract and `MemoryGoalPlanStore` (`goal-plan-store.ts`) for upserting goals and appending plan versions.
  - Deterministic planner (`planner.ts`): `classifyTaskComplexity` gates on a baseline heuristic (short single-sentence Q&A is simple; multi-sentence, long, multi-step, or project-verb requests are complex), `deriveGoal`/`derivePlanSteps` build the goal and a three-phase DAG, and `createGoalPlanHook` is the `AgentLoopPlanHook` that plans only on the first step of a complex turn — simple turns produce no output, so Q&A stays ceremony-free.

- bedbda4: Link Kanban tasks and Threads bidirectionally (v1 refactor plan §5.2 P2-4).

  - `KanbanSource` gains `itemId` (the originating tool_call item), so a task points at its Thread, Turn, and originating Item in one hop; artifact and trajectory references stay on the task for the Episode/Artifact direction.
  - `KanbanStore.list` gains `sourceThreadId` / `sourceItemId` filters, so a Thread or Item resolves back to its tasks in one hop — no multi-hop joins.
  - The kanban tool executor accepts a `context` (`threadId`/`turnId`/`itemId`) and `kanban_create` records it as the task's `source`; `AgentLoopToolSlotCall` now carries the tool_call `itemId`, and the host wires that context through to the executor.

- e606923: Add the LLMRuntime contract (architecture §10.2): a stateless, per-model inference seam. The AgentLoop passes a fully assembled ContextBundle (messages, tool specs, optional decision schema) per call — providers never hold message state. Calls stream message deltas, tool intents, and structured decisions, and settle with a result carrying stop reason, token/cost usage, provider metadata, and latency. Cancellation goes through AbortSignal and settles `stopReason: 'cancelled'`; every failure rejects with `LlmRuntimeError` carrying a retryability classification (`retryable`, `fatal`, `context-overflow`) plus `classifyLlmError` for unclassified errors. Capability discovery exposes streaming/tools/structured-decision support and context/output token limits. `@bee-agent/runtime/testing` ships `createFakeLlmRuntime`, a deterministic scriptable implementation that records calls, honors abort mid-stream, and fails loud on script exhaustion.

### Patch Changes

- Updated dependencies [9be74e1]
- Updated dependencies [34d0d4f]
- Updated dependencies [6c62bd0]
- Updated dependencies [b1a48bf]
- Updated dependencies [b1a48bf]
- Updated dependencies [e359897]
- Updated dependencies [e359897]
- Updated dependencies [1e2c0de]
- Updated dependencies [c6924a4]
- Updated dependencies [cdcba95]
- Updated dependencies [84e646b]
- Updated dependencies [8e04cd7]
- Updated dependencies [40988a8]
- Updated dependencies [bedbda4]
- Updated dependencies [066bd78]
- Updated dependencies [4c7f805]
- Updated dependencies [7460bb1]
- Updated dependencies [4ebc68b]
- Updated dependencies [61eeadb]
- Updated dependencies [85be532]
- Updated dependencies [de9f3f4]
- Updated dependencies [1c6c976]
- Updated dependencies [b67f04a]
- Updated dependencies [edbe21b]
- Updated dependencies [a5553f1]
- Updated dependencies [149fddf]
  - @bee-agent/kernel@1.0.0
  - @bee-agent/knowledge@0.2.0
  - @bee-agent/thread@0.2.0
  - @bee-agent/context@0.2.0
  - @bee-agent/kanban@0.2.0
  - @bee-agent/execution@0.2.0
