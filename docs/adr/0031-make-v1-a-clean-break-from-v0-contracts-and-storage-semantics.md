# ADR 0031: Make v1 a clean break from v0 contracts and storage semantics

## Background

v1 changes the interaction protocol (Thread–Turn–Item replaces the task API), the event envelope (Chronicle streams with expected sequences, schema registry, and causality replace per-task events), the task model (durable Kanban replaces the one-shot state machine), and the plugin contract (enforced capabilities/permissions/sandboxing). Preserving v0 compatibility would mean maintaining two semantics for every one of these through the entire refactor.

## Decision

v1.0.0 is a clean break: the v0 `TaskRuntime`, agent-internal tool loop, direct-spawn paths, in-memory approvals, `/tasks` API surface, and v0 event/plugin contracts are **rewritten or deleted, not facaded**. Old paths are removed at each phase's exit — "the old interface still works" is never a completion standard, only "the new architecture runs on its own". v0 data moves only through an explicit export/import tool; old MemoryRuntime data is an import source, not a v1 schema. Plugins must migrate to the new manifest, capability, permission, and sandbox contracts. `main` receives critical v0 fixes only, and the v0 line is frozen at the `v0.11.0-legacy` tag.

## Reasons

Every audited structural problem (messages state inside the provider, one-shot tasks, in-memory approvals, per-module spawns) lives in the contracts themselves; a transition layer would freeze those seams in place while doubling the surface under test for the whole 7-phase refactor.

## Alternatives

Parallel-run with a compatibility facade (double semantics until 2.0), strangler-fig migration per endpoint (the protocol change is cross-cutting, not incremental), or importing v0 data in place (old model would contaminate Chronicle invariants).

## Positive impact

The team deletes instead of maintains; tests assert one semantic; the new invariants (expected sequences, ignorable rules, approval durability) hold from day one instead of being bridged.

## Negative impact

No upgrade path without running the import tool; external v0 plugin consumers break once; during the refactor the branch is a construction site — each phase must still demo end-to-end on its own contracts to stay mergeable.

## Follow-up constraints

Each phase ends with its old-path deletion verified green (build/typecheck/lint/test); the export/import tool ships in Phase 6 as the only v0 bridge; the v1 plans in `docs/architecture/` are the authoritative scope reference.
