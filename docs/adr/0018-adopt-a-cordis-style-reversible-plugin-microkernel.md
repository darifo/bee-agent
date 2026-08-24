# ADR 0018: Adopt a Cordis-style reversible plugin microkernel

## Background

ADR 0001 put Cordis under `packages/kernel` for contexts, scopes, services, and plugin lifecycle. The v1 audit found the seam under-used: the domain bus has only serial and waterfall modes, plugin effects have no unified reversible lifecycle, capabilities/permissions in plugin manifests are declarative only, and there is no bundle resolution — so composition, hot replacement, and supply-chain enforcement have nothing to stand on.

## Decision

Deepen `packages/kernel` into a Cordis-style microkernel with six mechanisms: **service slots** (`ctx.model`, `ctx.threads`, `ctx.kanban`, …) consumed through typed contracts; **explicit injection** where plugins declare the services they need and missing services fail loud; **four event modes** (`emit` broadcast, `parallel`, `serial`, `waterfall`); **reversible effects** where every tool/hook/listener/section registration returns a disposer and unmount releases effects in reverse order, with drain/quiesce, health checks, and a quarantine + `restart-required` state for failed unloads; **bundle composition** resolving to an immutable, digest-stamped `EffectiveStructure` recorded in the Chronicle — with exactly one root Profile, `bee`; and **tiered hot replacement** (A live, B turn-boundary, C restart-required) where an executing Turn pins its StructureVersion. Manifest capabilities/permissions become enforced at mount, not just validated.

## Reasons

This is the composition style DeepSeek Harness/Cordis validated at scale, adapted to one root profile instead of many; reversibility is what makes hot replacement, experiments, and rollback safe enough for a self-improving agent; and the turn-pinned structure version keeps replayability while allowing evolution.

## Alternatives

Keep the thin current wrapper (no basis for bundles or tiers), adopt the full DeepSeek Harness plugin ecosystem (host complexity aimed at a different product), or a hand-rolled DI container (rebuilds Cordis badly).

## Positive impact

Model, memory, sandbox, and tool adapters become interchangeable behind slots without touching the loop; plugin conflicts and unknown permissions fail at startup; the same lifecycle model covers dev HMR and production replacement.

## Negative impact

More kernel surface to test (tiers, drain, quarantine); plugin authors must declare injects and disposers; tier-C components still need restarts, so "hot" must never be promised universally.

## Follow-up constraints

The kernel carries no product business — Thread, Kanban, and the loop are hosted base plugins; core business packages keep importing kernel services, never Cordis directly (ADR 0001); replacement tiers must stay testable (A/B/C contract tests in CI); secrets and the personal data directory stay outside plugin reach per `docs/architecture/bee-agent-v1.0.0-threat-model.md`.
