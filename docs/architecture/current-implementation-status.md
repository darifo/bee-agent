# Bee Agent v1 current implementation status

> Snapshot: 2026-08-27
>
> Branch: `feature/v1.4.0` (Phase 4 in progress)
>
> Migration: clean break from `v0.11.0-legacy`

## Runtime topology

```text
Personal Bee Host
  └─ Kernel / active StructureGeneration
       ├─ Chronicle + SQLite
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
       └─ AgentLoop (Turn-scoped generation lease + memory/plan hooks)
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

Phase 4 has started on `feature/v1.4.0`. Landed so far:

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

Still pending in Phase 4: memory-remote bridge with explicit degradation
(WF4-C), World/Structure projections (WF4-D), trajectory replay views
(WF4-E), the scheduler and durable long-running queue (WF4-F), the unified
personal data directory, and the Phase 4 CI gates (provider outage
degradation, fake-clock cross-day recall).

## Phase 3 completion

Phase 3 is complete. Ubuntu CI installs bubblewrap and requires the real
filesystem boundary plus cross-platform process-group cancellation contracts.
The macOS suite retains Seatbelt coverage. Network execution is separated from
the command sandbox and requires an exact-origin, Host-injected transport;
unsupported network requests continue to fail closed.

The current default Host has no implicit RemoteAgent or coding checkout. Those
capabilities activate only when an reviewed manifest/bundle supplies a network
transport or repository/worktree roots. This is configuration, not unfinished
execution infrastructure.

## Later phases

- Phase 4 remainder: memory-remote bridge, world model, trajectory views,
  scheduler/long-running queue, and the unified personal data directory (see
  "Phase 4 progress" above for the landed memory foundation).
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
- 349 passing workspace tests (1 platform-specific skip), including
  PluginCatalog selection, A/B/C reconciliation,
  config refresh/rollback, Doctor quarantine, the MemoryProvider contract
  suite over the embedded provider, end-to-end Host memory
  recall/derivation/retraction, real macOS Seatbelt Command/Python/MCP
  contracts and mandatory Ubuntu bubblewrap contracts in CI.
