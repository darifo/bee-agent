# ADR 0030: Adopt a Cordis-derived Context–Registry–Fiber Kernel

> Status: Accepted and implemented
>
> Date: 2026-08-25

## Background

ADR 0001 put Cordis under `packages/kernel`, and ADR 0018 deepened it into a Cordis-style microkernel. The Phase 1 implementation stopped short of that: it replaced the `cordis` dependency with a minimal own `Context` (~2.3k LOC) that has service slots, events, effects, and plugin mounting, but lacks Proxy service access, `inject`, a `Fiber` plugin runtime, a `Registry`, and reactive dependency remount. The kernel-opt plan re-oriented the target to a full Context–Registry–Fiber runtime with `StructureGeneration`, and its Stage 0 Spike confirmed that `cordis@4` actually ships the full lower layer — `Context` with Proxy service access and built-in `events`/`reflect`/`registry` services, `ReflectService`, `RegistryService`, a `Fiber` with a `PENDING/LOADING/ACTIVE/FAILED/DISPOSED/UNLOADING` state machine, `inject`, scoped async effects, `isolate`/`intercept`, and Standard-Schema config validation.

The npm `cordis` package is still a release candidate (`4.0.0-rc.8` is `latest`; the README says "API is not yet stable and may change without notice"), which makes it a poor foundation to depend on directly. A better source exists: the deepseek-harness project vendors cordis as `@deepseek-ai/cordis@4.0.1` with the full TypeScript source — 2693 LOC across `context/events/fiber/logger/reflect/registry/service/utils`, MIT — plus a small `cosmokit` utility vendor (477 LOC, of which the kernel uses only the `Dict`/`Awaitable`/`Promisify` types and the `defineProperty`/`isNullable`/`hyphenate` helpers, ~60 LOC).

## Decision

Bee adopts a **Cordis-derived Context–Registry–Fiber kernel** by **porting the vendored cordis 4.0.1 source into `@bee-agent/kernel`**, not by depending on the npm `cordis` package. The port takes the MIT-licensed cordis source plus the small `cosmokit` subset it needs, adapts the `@deepseek-ai/*` scope to Bee, and inlines the Standard Schema v1 type surface. On top of the ported runtime, Bee builds the pieces cordis does not provide — `StructureGeneration` (two-generation switching with reference counting), Turn structure pinning (`GenerationLease` + `StructureVersion`), monotonic permission restriction (`ContextPolicy`), and B/C replacement governance. Business packages depend only on `@bee-agent/kernel`; npm `cordis` and `cosmokit` packages are never added to the workspace.

## Reasons

The vendored 4.0.1 source gives Bee a proven, tested implementation of exactly the reactive plugin-runtime semantics it needs, while owning the code avoids the instability of the npm release candidate and removes that runtime dependency. Porting ~2.7k LOC of MIT source plus a tiny utility subset is cheaper and lower-risk than reimplementing the same asynchronous lifecycle from scratch, and owning the source means Bee can fix or extend the runtime directly rather than wait on an upstream RC.

## Alternatives

**Depend on npm `cordis@4.0.0-rc.8`** (thin adapter): the least code to write, but it builds the kernel on an unstable, not-yet-stable API and adds the RC plus `cosmokit` as runtime dependencies. **Reimplement from scratch** (grow the existing 2.3k-LOC own `Context` with Reflect/Registry/Fiber/inject/reactive remount/config validation): full control and no port, but ~1000–1500 lines of subtle async lifecycle plus a double test surface. **Stay with the minimal own Context**: cannot express `StructureGeneration`, reactive dependencies, or a unified Fiber lifecycle.

## Positive impact

Model, memory, sandbox, tool, and loop providers become interchangeable behind slots; plugin dependency errors surface at startup with a real fiber state machine; scoped effects and reactive remount come from a proven implementation Bee now owns and can evolve; no unstable npm dependency enters the core.

## Negative impact

Bee takes ownership of ~2.7k LOC of ported kernel code that it must maintain and, if desired, keep aligned with upstream cordis (MIT permits forking without obligation). The port strips the `@deepseek-ai/*` scope, keeps MIT attribution, and carries a small inlined Standard Schema type surface.

## Follow-up constraints

`@bee-agent/kernel` vendors the cordis source under Bee's own scope and retains MIT attribution; npm `cordis`/`cosmokit` packages are forbidden by the package-boundary scanner; business packages import only `@bee-agent/kernel`; `StructureGeneration`, Turn pinning, `ContextPolicy`, and B/C governance remain first-class Bee implementations with contract tests.

## Implementation outcome

The old parallel Context/EventBus/EffectScope/TaskScope/PluginHandle/ReplacementCoordinator implementation and `@bee-agent/kernel/testing` compatibility subpath were removed. `RuntimePlugin.inject` maps directly to the Cordis Fiber dependency set. `Kernel.reconcile()` validates missing dependencies, duplicate providers, cycles, and structure-version collisions before switching generations. `apps/bee` now obtains AgentLoop from a Kernel-managed plugin graph and holds a generation lease across approval suspension.
