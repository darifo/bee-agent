# @bee-agent/kernel

## 1.0.0

### Major Changes

- 066bd78: Absorb the `@bee-agent/plugin-sdk` contract into the kernel (`PluginManifestSchema`/`BeeAgentPlugin` now live in `@bee-agent/kernel`) and drop the v0 `event-store`/`vector-store`/`storage` service keys. The kernel no longer imports any internal package.

### Minor Changes

- 9be74e1: Expanded the Cordis kernel foundation. The `Kernel` now tracks an explicit lifecycle state machine (`created → starting → started → stopping → stopped`) with `state-changed` events, rejects restarts after shutdown, and disposes all task scopes and mounted plugins deterministically on `stop()`.

  - Typed service keys via `defineServiceKey` plus `getService`, `hasService`, and `waitForService` (with optional timeout) so composition roots can await infrastructure readiness.
  - `use()` mounts Cordis plugins and `useBeeAgentPlugin()` adapts `@bee-agent/plugin-sdk` Bee Agent plugins: it awaits `start()`, publishes services afterwards, exposes a `ready` promise, and guarantees exactly-once awaited `stop()`.
  - `TaskScope` gains `onDispose` callbacks, duplicate-id protection, lookup/disposal helpers (`getTaskScope`, `disposeTaskScope`, `taskScopes`), and disposed-state sync when the kernel shuts down.
  - Kernel events (`service-registered`, `service-unregistered`, `task-scope-created`, `task-scope-disposed`, `plugin-mounted`, `plugin-unmounted`) are emitted for every lifecycle change, including services registered by mounted plugins.
  - Typed domain event bus: `defineSerialEvent`/`defineWaterfallEvent` keys, awaited serial dispatch, and waterfall middleware chains that can intercept or short-circuit a terminal implementation; task scopes expose a scope-bound bus view (`scope.events`) whose registrations are removed on disposal.
  - Standard service key catalog (`storageService`, `eventStoreService`, `vectorStoreService`) so plugins and composition roots share one vocabulary for infrastructure services.
  - `TaskScope.isolateService` gives a scope its own service slot (optionally shared with other scopes through a realm symbol) without affecting the global service; `KernelConfig.config` forwards application configuration to the Cordis root context.

- e359897: Add the bundle → EffectiveStructure layer for the single `bee` root profile. `BundleSchema` composes structure references (model, prompt, context policy, memory view, sandbox, eval policy, skills, tools, permissions, budgets) with `includes` for layering; `resolveEffectiveStructure` folds the chain includes-first so the includer wins conflicts, fails loud on cycles, loader mismatches, and unpinned scalar slots, and records provenance (which bundle version contributed each node). The digest is a sha256 over the canonical JSON form, so the same bundle always resolves to the same digest regardless of permission/budget authoring order. Also exports `structureVersionOf` and `traceStructure` for provenance queries.
- cdcba95: Added the deterministic test baseline behind a `@bee-agent/kernel/testing` subpath export (v1 refactor plan §4.2).

  - `Clock` interface plus `FakeClock`: manually advanced time with a deterministic timer queue — `schedule` mirrors `setTimeout`, `advance` fires due timers in (time, id) order including timers chained while advancing, and canceled timers never run.
  - `createFakeTool`: scriptable tool that records every invocation and echoes input by default, for asserting loop/tool-pipeline behavior without real capabilities.
  - `createScriptedModel`: provisional model double that issues scripted decisions (`text` / `tool-call` / `error`) in order and rejects loudly when the script runs dry; it will conform to the Phase 1 `LLMRuntime` contract.

- 4c7f805: Drop the `cordis` dependency and replace it with a minimal own `Context` (`packages/kernel/src/context.ts`). It reproduces only the surface the kernel uses — service slots (`get`/`set`), event listeners (`on`/`emit` that reach ancestors), reversible effects (`effect`), plugin forking (`plugin`), service isolation (`isolate` with shared realms), and `start`/`stop` — with the same semantics cordis provided for them, while leaving out the heavyweight traceable-proxy/inject/reactive-config machinery the kernel never used.
- 4ebc68b: Formalize reversible effects and the plugin lifecycle. New `EffectScope` registry releases disposers in reverse registration order, keeps releasing after failures, and reports every failure; `TaskScope.onDispose` now runs through it and `TaskScope.dispose`/`Kernel.disposeTaskScope` are async. `Kernel.stop` tears down task scopes and plugins in reverse creation/mount order. Plugins may implement optional `drain` (quiesce with timeout report) and `healthCheck` hooks, exposed on every `PluginHandle` with sensible defaults. A failed unload quarantines the handle (`status: 'quarantined'`), records it on the kernel (`quarantinedPlugins`, `restartRequired`, `plugin-quarantined` event), never retries the failed cleanup, and refuses remounting the same plugin id until restart.
- b67f04a: Add tiered hot replacement (architecture §9.3). Plugins declare a `replacementTier` on their mount options (`a` swaps only with no call in flight, `b` defers to the Turn boundary, `c` refuses hot replacement), and `ReplacementCoordinator` enforces the boundaries: `beginTurn` pins a structure version, `endTurn` drains then applies deferred B-tier replacements in order, and a running Turn's pinned structure version is never changed by a replacement.
