# Bee Agent v1 current implementation status

> Snapshot: 2026-08-26
>
> Branch: `feature/kernel-opt`
>
> Migration: clean break from `v0.11.0-legacy`

## Runtime topology

```text
Personal Bee Host
  └─ Kernel / active StructureGeneration
       ├─ Chronicle + SQLite
       ├─ Kanban + dispatcher
       ├─ ModelRequestService → OpenAI-compatible LLMRuntime
       ├─ ToolExecutionService → ExecutionWorld
       │    ├─ authorization / durable approval
       │    ├─ SecretBroker
       │    └─ RoutingSandboxProvider
       │         ├─ InProcessToolSandbox (logical Kanban tools only)
       │         └─ PlatformCommandSandbox (Seatbelt / bubblewrap)
       └─ AgentLoop (Turn-scoped generation lease)
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
  drain, tier-B replacement, and tier-C restart-required reporting.
- EffectiveStructure-driven factory registry, deterministic digest,
  serialized reconcile, Chronicle lifecycle facts, failed candidate rollback,
  inspection endpoint, and restart rebuild.

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
- Idempotent replay, collision detection, and reconciliation-required handling
  after ambiguous crashes.
- SecretBroker seam, macOS Keychain provider, minimal env injection, and
  result/error/diff redaction.
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

### Host and clients

- `@bee-agent/bee` Fastify composition root.
- Loopback bind default, session-token guard, loopback-only CORS, and protected
  SSE/management routes.
- `@bee-agent/client`, Thread/Kanban CLI, and React conversation/Kanban UI.
- SQLite Chronicle and Kanban adapter.

## Pending before Phase 3 completion

- Materialized permission snapshot covering hard denies, Structure grants,
  plugin declarations, task scope, and sandbox capabilities as one monotonic
  intersection.
- Linux real-host bubblewrap contract CI, network/path escape matrix, and
  cross-platform orphan-process tests.
- Worktree provider and coding-bundle defaults.
- Episode-scoped bounded delegation with depth/concurrency/token/time/cost/
  world limits and parent/child trajectory lineage.
- RemoteAgent replacement. It additionally requires an enforcing network
  provider, schema/redaction translation, and cancellation propagation; Host
  network access must not become an execution bypass.
- Artifact/log secret scanning and non-macOS system credential providers.

## Later phases

- Phase 4: personal memory, claims/representations, world model, artifact
  store, scheduler, and unified personal data directory.
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
- 298 tests, including real macOS Seatbelt Command, Python, and staged MCP
  integration contracts.

Linux bubblewrap behavior still requires a real Linux CI runner before Phase 3
can be declared complete.
