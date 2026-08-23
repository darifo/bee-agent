---
'@bee-agent/kernel': minor
---

Expanded the Cordis kernel foundation. The `Kernel` now tracks an explicit lifecycle state machine (`created → starting → started → stopping → stopped`) with `state-changed` events, rejects restarts after shutdown, and disposes all task scopes and mounted plugins deterministically on `stop()`.

- Typed service keys via `defineServiceKey` plus `getService`, `hasService`, and `waitForService` (with optional timeout) so composition roots can await infrastructure readiness.
- `use()` mounts Cordis plugins and `useBeeAgentPlugin()` adapts `@bee-agent/plugin-sdk` Bee Agent plugins: it awaits `start()`, publishes services afterwards, exposes a `ready` promise, and guarantees exactly-once awaited `stop()`.
- `TaskScope` gains `onDispose` callbacks, duplicate-id protection, lookup/disposal helpers (`getTaskScope`, `disposeTaskScope`, `taskScopes`), and disposed-state sync when the kernel shuts down.
- Kernel events (`service-registered`, `service-unregistered`, `task-scope-created`, `task-scope-disposed`, `plugin-mounted`, `plugin-unmounted`) are emitted for every lifecycle change, including services registered by mounted plugins.
- Typed domain event bus: `defineSerialEvent`/`defineWaterfallEvent` keys, awaited serial dispatch, and waterfall middleware chains that can intercept or short-circuit a terminal implementation; task scopes expose a scope-bound bus view (`scope.events`) whose registrations are removed on disposal.
- Standard service key catalog (`storageService`, `eventStoreService`, `vectorStoreService`) so plugins and composition roots share one vocabulary for infrastructure services.
- `TaskScope.isolateService` gives a scope its own service slot (optionally shared with other scopes through a realm symbol) without affecting the global service; `KernelConfig.config` forwards application configuration to the Cordis root context.
