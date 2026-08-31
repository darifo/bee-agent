# Bee Agent v1 current implementation status

> Snapshot: 2026-08-29
>
> Branch: `develop` (Phase 4 complete; Phase 5 in progress)
>
> Migration: clean break from `v0.11.0-legacy`

## Runtime topology

```text
Personal Bee Host
  └─ Kernel / active StructureGeneration
       ├─ Chronicle + SQLite (unified personal data directory)
       ├─ Kanban + dispatcher
       ├─ EmbeddedMemoryProvider (memory stream projection)
       │    ├─ recall: AgentLoop retrieve hook (budgeted context section)
       │    └─ near-line MemoryDerivationWorker after completed Turns
       ├─ ModelRequestService → OpenAI-compatible LLMRuntime
       ├─ ToolExecutionService → ExecutionWorld
       │    ├─ authorization / durable approval
       │    ├─ SecretBroker
       │    └─ RoutingSandboxProvider
       │         ├─ InProcessToolSandbox (logical Kanban tools only)
       │         └─ PlatformCommandSandbox (Seatbelt / bubblewrap)
       ├─ WorldProjectionService (catch-up + live sourced projectors)
       ├─ AgentScheduler (time + Kanban-condition/event triggers)
       └─ AgentLoop (Turn-scoped generation lease + memory/plan hooks)

Read-only projections over the same Chronicle: GET /world (versioned,
digest-verified), GET /structure lineage, per-Turn trajectories with
digest-checked model replay. The HTTP surface is documented in
[docs/api.md](../api.md).
```

New Turns acquire the active generation. A reconciled Structure prepares and
activates a candidate before the old generation drains. Suspended approval
Turns retain their original lease until completion, failure, or cancellation.

## Implemented

### Kernel and structure

- Proxy Context with scoped service lookup.
- Registry/Fiber ownership, `inject` dependency activation, restart, and LIFO
  effect cleanup.
- `ctx.effect()`, `ctx.on()`, and `ctx.provide()` ownership by the active Fiber.
- Context derive/isolate/intercept and monotonic ContextPolicy restriction.
- Immutable StructureGeneration, reference-counted leases, prepare/activate/
  drain, config-only tier-A Fiber update with rollback, tier-B replacement,
  and tier-C restart-required reporting. Tier A only mutates a quiescent
  generation; an active Turn forces a safe generation swap.
- EffectiveStructure-driven built-in factory registry plus trusted,
  exact-version PluginCatalog; Bundle plugin instances, deterministic digest,
  serialized reconcile, Chronicle lifecycle facts, failed candidate rollback,
  inspection/Doctor endpoint, cleanup quarantine, and restart rebuild.
- ConfigSource controller with coalesced file/custom-source refresh; invalid
  JSON, forged digests, missing plugins, and failed candidates retain the
  active generation.

### Protocol and durable runtime

- Chronicle schemas, append-only streams, expected sequence, and replay.
- Thread–Turn–Item REST/SSE protocol with `Last-Event-ID` resume.
- AgentLoop checkpoints, approval suspension/resume, cancellation, exact tool
  result history, and digest-checked crash recovery.
- Durable ModelRequestService with ContextManifest/source snapshots and
  requested/completed/failed facts.
- Durable Kanban state machine, dependencies, claim/lease/heartbeat,
  dispatcher recovery, SDK, CLI, and Web board.
- Context budgets, protected sections, omission manifests, Tool/Skill index and
  resolver, and token-baseline regression gate.

### AgentLoop interaction hardening (benchmark-driven pass)

The model-interaction seam, dispatch, and context lifecycle were hardened
against the converged patterns of the production agent codebases (Claude
Code, Codex CLI, DeepSeek Harness, Hermes Agent):

- **Streaming provider surface**: `OpenAIChatRuntime` streams over SSE
  (`stream: true` + `include_usage`), pushing message deltas as chunks
  arrive and assembling tool intents from streamed argument fragments; a
  JSON (non-event-stream) response falls back to the buffered path, so both
  wire shapes produce identical events. Request timeouts cover headers
  only; long streams are not killed mid-flight. `Retry-After` is parsed
  into `LlmRuntimeError.retryAfterMs`.
- **Loop resilience**: retries back off (Retry-After, then exponential,
  30s cap); malformed tool arguments surface as `inputError` on the call
  and never execute — they return to the model as an error result; a
  throwing tool is isolated as an `isError` tool message instead of failing
  the turn (recorded as `item.completed` so checkpoint digests stay
  rebuildable); `max_tokens` doubles the output cap and regenerates the
  step rather than failing outright. Message deltas are buffered (256-char
  flush) so streaming does not become one Chronicle write per chunk.
- **Thread continuity**: a Turn's model-visible history starts with the
  thread's prior turns — completed messages and tool calls across all
  turns, in sequence order — so a thread is one conversation. Crash
  recovery rebuilds the same construction (carried prefix + committed
  turn items), keeping checkpoint digests verifiable.
- **System prompt assembly**: one memoized system message (default Bee
  identity/permissions prompt, `BEE_AGENT_SYSTEM_PROMPT` override, or a
  budgeted `SystemPromptAssembler` over prioritized sections via the
  context package's allocation) leads every request — byte-stable for
  provider prefix caching; per-turn context stays in the late hook
  messages.
- **Context compaction, two levels, one discipline** — fold the
  model-visible view, never the log. Level 1 projects old tool results to
  deterministic placeholders under a token budget (errors and the recent
  window protected; elisions recorded as manifest omissions). Level 2
  summarizes the covered history prefix with one durable tool-free model
  call over a threshold (default 70% of the context window) and records a
  `context.compacted` event (summary, covered count, covered digest); the
  projection folds the prefix into a single summary message, re-verifying
  the digest on every fold and reload. A per-turn attempt budget (default 2) breaks failing summarizer loops.
- **Tool concurrency**: tools declare `concurrency` (`parallel` |
  `exclusive`; absent = exclusive, fail-closed). Consecutive same-class
  intents form segments — parallel-safe calls dispatch as a bounded batch
  (default 8) while exclusive calls stay ordered; results commit in model
  order regardless of completion order. `kanban_list`/`kanban_show` are
  parallel-safe. A suspended or crashed step finishes its unexecuted tool
  calls on resume/recovery (idempotency keys make re-dispatch safe);
  Chronicle appends serialize through a write queue.
- **Keyless replay harness**: fixtures under
  `packages/runtime/tests/replay/` script recorded model responses and
  tool outcomes, run the real loop + ModelRequestService + Chronicle
  pipeline, and diff turn results, the exact model-visible requests, and
  every Chronicle stream against the recorded expectation (uuid/timestamp
  normalization). Regenerate after intentional changes with
  `REPLAY_RECORD=1 pnpm --filter @bee-agent/runtime test`. Its first
  recordings caught and fixed three real defects (invalid
  `isError: undefined` JSON in recorded sources, a concurrent-append race,
  and the suspended-step sibling-call loss).

### Execution and tools

- Canonical ActionRequest and ResourceRequirements validation.
- Deny-by-default capability policy and durable approval details over expanded
  executable, argv, paths, secret refs, expected effects, and verification.
- Materialized monotonic permission snapshots spanning hard safety, active
  Structure grants, user grants, Bee policy, plugin declarations, task scope,
  and the selected sandbox capability report.
- Idempotent replay, collision detection, and reconciliation-required handling
  after ambiguous crashes.
- SecretBroker seam, macOS Keychain provider, minimal env injection, and
  result/error/diff redaction.
- Linux Freedesktop Secret Service provider and secret-scanning artifact store.
- Platform capability probing; fail closed without required filesystem,
  process, or network enforcement.
- macOS Seatbelt and Linux bubblewrap policies, empty child environment,
  bounded stdin/stdout/stderr, timeout/AbortSignal process-group termination,
  and world snapshots/diffs.
- `command_run`: native executable allowlist and canonical workspace.
- `python_run`: fixed native interpreter, bounded JSON stdin, explicit runtime
  read roots, and isolated one-shot execution.
- `mcp__<server>__<tool>`: Host-pinned schemas and resources, staged JSON-lines
  initialize/initialized/tools-call session, matching response termination,
  and deterministic result presentation.
- Repository scanner and ESLint boundary prevent process spawning outside
  `packages/execution`.
- ExecutionWorld-routed Git worktree lifecycle, exact-origin network sandbox,
  declarative RemoteAgent v2, and episode-scoped delegation bounded by depth,
  concurrency, children, time, tokens, cost, and world actions.

### Host and clients

- `@bee-agent/bee` Fastify composition root.
- Loopback bind default, session-token guard, loopback-only CORS, and protected
  SSE/management routes.
- `@bee-agent/client`, Thread/Kanban CLI, and React conversation/Kanban UI.
- SQLite Chronicle and Kanban adapter.

## Phase 4 progress (memory foundation)

Landed on `feature/v1.4.0`:

- Memory domain in `@bee-agent/knowledge` (WF4-A): Claim/Observation/
  Representation schemas with provenance pointing at Chronicle positions,
  valid-time intervals, supersedes/retract statuses, the `MemoryProvider`
  contract (ingest/query/buildContext/getRepresentation/derive/consolidate/
  retract/export/health), a serialized `memory` Chronicle stream with
  registered event types, and an implementation-agnostic contract suite.
- Embedded `@bee-agent/memory-bee` provider (WF4-B core): an in-memory
  projection over the durable `memory` stream with restart rebuild, lexical
  recall (English words plus CJK chars/bigrams, stopword filtering),
  budgeted context sections, deterministic preference/correction derivation
  (corrections supersede the latest recorded preference), and duplicate
  consolidation via supersede events. FTS/local-vector indexing remains a
  follow-up; correctness today does not depend on it.
- Runtime wiring: `createMemoryRetrieveHook` (recall as the AgentLoop
  retrieve hook; an unavailable provider skips recall instead of injecting
  stale memory), the near-line `MemoryDerivationWorker` (completed Turns
  only, failures captured in reports, never fail the Turn), and
  `RememberingAgentLoop` around the pinned loop.
- Host wiring: `bee.memory` tier-B service, memory governance routes
  (`GET /memory/claims`, `POST /memory/claims/:claimId/retract`,
  `POST /memory/consolidate`, `GET /memory/export`), the Goal/Plan hook on
  complex turns, and optional `BEE_AGENT_STRUCTURE_FILE` watched structure
  reload through `StructureConfigController`.
- Remote-memory degradation (WF4-C core): a `memory.health.changed` Chronicle
  event records every provider health transition; calls fail fast with
  `MemoryProviderUnavailableError` once a circuit opens; `@bee-agent/
memory-remote` provides the `MemoryBridgeTransport` seam (plus an in-process
  SDK bridge) and `RemoteMemoryProvider` with a consecutive-failure circuit
  breaker that recovers through health probes; the recall hook skips
  gracefully when a circuit opens mid-call. HTTP/MCP transports remain
  follow-ups pending a wire-protocol decision.
- Phase 4 CI gates: the contract suite is self-validated against a reference
  in-memory provider, conflicting claims stay visible until corrected,
  outage/recovery transitions are asserted against the durable stream, and a
  fake-clock test covers weeks-later recall with corrections and expired
  valid-time facts.
- World model (WF4-D core): world entities, provenance-carrying relations,
  and versioned snapshots in `@bee-agent/knowledge`, persisted on a
  serialized `world` Chronicle stream whose version bumps carry a digest of
  the full projected state — rebuilds verify every digest and fail loud on
  drift. Facts only enter through sourced `WorldProjector`s (the bundled
  `ThreadToolProjector` derives agent→tool usage from completed tool calls
  with exact item provenance); the Host replays catch-up at start, projects
  live appends, and serves a read-only `GET /world` view.
- Long-running scheduler (WF4-F core): `AgentScheduler` in
  `@bee-agent/runtime` — one-shot and recurring triggers that continue a
  bound thread across days and restarts. Trigger state is the serialized
  `scheduler` Chronicle stream (registered/triggered/removed) and rebuilds
  on restart; ticks fire due triggers under a fire-once catch-up policy that
  collapses missed intervals into one run (reporting the count and resuming
  the original cadence), scheduler-launched turns carry trigger `schedule`,
  and a crashing turn still advances the schedule. The Host enables it by
  default (5s auto-tick) with `/scheduler/triggers` CRUD and a manual
  `POST /scheduler/tick`. Condition triggers: `when.taskStatus` fires once a
  Kanban task reaches a status (durable catch-up through the task stream)
  and `when.event` fires on matching appended events via `notify`.
- Trajectory views (WF4-E): `buildTurnTrajectory` projects one Turn's causal
  chain — generations with structure versions and digest-verified model
  inputs, tool actions with capability/decision/outcome from execution
  streams, and checkpoints. `replayGeneration` returns the exact
  model-visible bundle (manifest + sources + rebuilt context, digest
  checked). Routes: `GET /threads/:threadId/turns/:turnId/trajectory` and
  `GET /model-requests/:requestId/replay`.
- StructureGraph (WF4-D remainder): `StructureGraphStore` replays the
  `structure` stream into a lineage view — versions with full phase
  history, supersession chains, and the active digest — exposed through
  `GET /structure`. The `ExecutionResourceProjector` derives file-resource
  dependencies and native-executable capabilities from
  `execution.requested` events and runs in the default Host world
  projection.
- Remote memory over HTTP (WF4-C complete): `FetchMemoryTransport` speaks a
  documented `/memory/*` REST contract (query/ingest/context/representation/
  derive/consolidate/retract/export/health) with bearer auth and explicit
  `MemoryTransportError` status mapping; the Host switches to it — behind
  the circuit breaker with durable health events — when
  `BEE_AGENT_MEMORY_REMOTE_URL` is set. The wire contract is pinned by a
  reference HTTP server test running the full round-trip.
- Unified personal data directory: durable Host artifacts default to
  `BEE_AGENT_DATA_DIR` or the platform convention (macOS Application
  Support / XDG data home) instead of the working directory; an explicit
  `BEE_AGENT_STORAGE_SQLITE_FILENAME` still wins.

## Phase 5 progress (slow loop foundation)

Phase 5 has started on `develop`. Landed so far:

- ImprovementProposal domain in `@bee-agent/learning` (WF5-B): 11 change
  types, the draft→testing→review→trial→promoted/rejected/rolled-back
  lifecycle with optimistic concurrency and illegal-transition rejection,
  and L0–L3 autonomy levels where the loop itself may never exceed L2
  (architecture §11.4). Proposals persist on a serialized `learning`
  Chronicle stream behind a rebuildable projection.
- The slow loop (WF5-A core): one budgeted background pass — Selection →
  Derivation → Consolidation → Pattern discovery over recent tool-using
  trajectories. The baselines are deliberately conservative and
  deterministic: high-frequency tool usage becomes skill candidates,
  repeated tool failures become guardrail observations, near-cap turn
  lengths become planning notes. Open targets dedupe, per-run proposal
  caps apply, and every run appends a durable `learning.loop.run` report.
- Host wiring: `POST /learning/run`, `GET /learning/budget`, proposal
  listing/detail, and user-driven lifecycle transitions (409 on illegal
  jumps or stale versions); optional background cadence (default hourly,
  `learning: { intervalMs }`). The loop never changes behavior directly —
  its only output is governed proposals (ADR 0025/0026 semantics).

Still pending in Phase 5: ExperimentWorld with disposable worktrees and
frozen datasets (WF5-C), autonomy-level activation plumbing (WF5-D beyond
proposal gating), anti-fake-improvement evaluation — holdout, baselines,
time-out validation (WF5-E), and the acceptance ADRs 0025/0026.

## Phase 4 completion

Phase 4 is complete against the §7.1 exit conditions:

- **Low-cost recall of past preferences**: budgeted, provenance-carrying
  recall through the AgentLoop retrieve hook; the fake-clock test recalls a
  corrected preference weeks later and expires time-boxed facts, and the
  Host integration test recalls a stated preference on the next turn.
- **Chronicle facts survive external-memory loss**: memory is a projection;
  the outage acceptance test runs a full conversation with a completely
  down remote memory — the turn completes, the thread facts are intact in
  Chronicle, and the outage is a durable `memory.health.changed` fact, never
  a silent empty recall.
- **User governance**: `/memory` routes view, correct (supersede), forget
  (retract), and export every claim, over the embedded or remote provider.

ADR 0021/0024/0027 are accepted and implemented. Residual enhancements are
tracked as post-phase backlog rather than open Phase 4 work: an MCP memory
transport variant behind the live HTTP contract, checkpoint-fork experiments
(consumed by Phase 5's ExperimentWorld), and the daemon/tray packaging form
(Phase 6 scope).

## Phase 3 completion

Phase 3 is complete. Ubuntu CI installs bubblewrap (lifting the AppArmor
unprivileged-userns restriction that newer runner images enforce, since the
image does not load bwrap's allowing profile) and requires the real
filesystem boundary plus cross-platform process-group cancellation contracts.
The macOS suite retains Seatbelt coverage. Network execution is separated from
the command sandbox and requires an exact-origin, Host-injected transport;
unsupported network requests continue to fail closed.

The current default Host has no implicit RemoteAgent or coding checkout. Those
capabilities activate only when an reviewed manifest/bundle supplies a network
transport or repository/worktree roots. This is configuration, not unfinished
execution infrastructure.

## Later phases

- Phase 4 backlog (post-phase): MCP memory transport variant,
  checkpoint-fork experiments, and the daemon/tray packaging form.
- Phase 5: governed derivation, Skill learning, proposals, experiments,
  evaluation, and rollback.
- Phase 6: migration/export tooling, packaging, soak/security acceptance, and
  v1 release.

PostgreSQL, pgvector, v0 MemoryRuntime, v0 TaskRuntime, old process tools, and
old CommandAgent/RemoteAgent are not current capabilities.

## Verification baseline

The current implementation passes:

- workspace build;
- strict TypeScript checks;
- ESLint and package/process boundaries;
- Prettier verification;
- 478 passing workspace tests (1 platform-specific skip), including the
  single-instance module-composition acceptance (one Host composing the
  kernel graph, execution, memory recall/derivation/governance, world
  projection, time- and Kanban-condition scheduling, trajectory replay,
  structure lineage, and exact projection rebuilds),
  PluginCatalog selection, A/B/C reconciliation,
  config refresh/rollback, Doctor quarantine, the MemoryProvider contract
  suite over the embedded and remote providers, end-to-end Host memory
  recall/derivation/retraction, remote outage/recovery transitions and the
  HTTP wire-contract round-trip, fake-clock long-horizon recall,
  world-projection digest verification and the live `GET /world` contract,
  scheduler due-time/cadence/catch-up and task/event condition contracts,
  trajectory projection with digest-verified model replay, StructureGraph
  lineage replay, real macOS Seatbelt Command/Python/MCP
  contracts and mandatory Ubuntu bubblewrap contracts in CI.
