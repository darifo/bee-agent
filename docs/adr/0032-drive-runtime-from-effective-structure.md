# ADR 0032: Drive the Runtime from EffectiveStructure

> Status: Accepted and implemented
>
> Date: 2026-08-25

## Context

ADR 0030 established the Context–Registry–Fiber kernel and reference-counted `StructureGeneration`, but the Host still assembled a hard-coded `RuntimePlugin[]` and used a constant structure version. That made Bundle resolution and the runtime graph two disconnected sources of truth. It also meant activation, failure, drain, disposal, and restart-required transitions were not durable facts.

## Decision

`EffectiveStructure` is the desired runtime state. A `PluginFactoryRegistry` deterministically translates it into a `PluginGraph`, and `StructureReconciler` is the only normal entrypoint for applying that graph to `Kernel.reconcile()`.

The reconciliation sequence is:

```text
Bundle → EffectiveStructure → structure.resolved
       → PluginFactoryRegistry → PluginGraph
       → candidate StructureGeneration
       → prepared → activated → drain/dispose previous
```

Every structure transition is appended to the Chronicle structure stream. A resolved candidate that fails or requires restart never replaces the last successfully activated digest. On Host restart, `readActiveStructure()` rebuilds the last activated `EffectiveStructure`, ignoring later failed or restart-required candidates.

Reconciliation calls and Chronicle structure-stream writes are serialized. Tier C governance compares plugin descriptors, so an unchanged C-tier provider does not block an unrelated B-tier model/tool/loop update.

## Host composition

The Bee Host registers factories for Chronicle, Kanban, model, tools, sandbox policy, and AgentLoop. Model bindings are keyed by `<structure model id>@<model version>`. Missing model/tool bindings fail before Kernel activation and create `structure.activation_failed` facts. The local admin surface exposes `GET /structure` and `POST /structure/reconcile`; the existing session-token hook protects these routes when authentication is configured.

## Consequences

- `EffectiveStructure.digest` is the generation `structureVersion`.
- New Turns see the newly activated generation; existing Turns retain their lease.
- Candidate failures keep the active generation usable.
- A C-tier descriptor change records `structure.restart_required` instead of partially applying the graph.
- Chronicle can distinguish desired, active, failed, draining, disposed, and restart-required structure states.
- Plugin selection logic belongs in factories, not in Fastify routes or Kernel internals.

## Follow-up constraints

Future Bundle/config file watchers call `BeeServer.reconcileStructure()` or the authenticated reconciliation endpoint. They must not invoke `Kernel.reconcile()` directly. Structure projection performance may later add a snapshot/index, but event semantics remain unchanged.
