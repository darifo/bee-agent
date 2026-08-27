# ADR 0024: Use memory-bee by default and memory-remote for every external memory

> Status: Accepted and implemented
>
> Date: 2026-08-27

## Context

Personal memory must work with zero external services, yet external memory
systems will be connected eventually. The dangerous failure mode is a remote
memory silently returning empty results: recall quietly stops working and
nobody can tell when it broke. Memory mutations also have to be user-
governable — viewable, correctable, forgettable, exportable — and independent
of any particular provider.

## Decision

One `MemoryProvider` contract (in `@bee-agent/knowledge`) with a contract
suite; every implementation satisfies the same semantics.

- **memory-bee** (`plugins/memory-bee`) is the default: an in-memory
  projection over a serialized `memory` Chronicle stream with restart
  rebuild, lexical recall (English words plus CJK chars/bigrams), budgeted
  context sections, deterministic preference/correction derivation, and
  duplicate consolidation. Claims carry provenance, valid-time intervals,
  and supersedes/retract statuses.
- **memory-remote** (`plugins/memory-remote`) is the only seam for external
  memories: a `MemoryBridgeTransport` interface, an in-process SDK bridge,
  and the documented `/memory/*` HTTP wire contract with bearer auth.
  `RemoteMemoryProvider` adds a consecutive-failure circuit breaker —
  fail-fast `MemoryProviderUnavailableError` calls, health-probe recovery —
  and records every health transition as a durable `memory.health.changed`
  fact. The recall hook skips gracefully when the circuit is open.
- Host wiring: embedded by default; `BEE_AGENT_MEMORY_REMOTE_URL/TOKEN`
  switches to the remote behind the breaker. Governance routes
  (view/forget/consolidate/export) work over either implementation.

## Consequences

- Chronicle facts survive any memory outage; memory is a projection, never
  the fact base.
- External memories cannot bypass the contract or inject unevidenced claims;
  degradation is explicit, auditable, and never a silent empty recall.
- The derivation baseline is deliberately conservative and deterministic; a
  model-driven deriver can replace it behind the same seam.
- FTS/vector indexing is a scale optimization inside memory-bee, not a
  dependency of correctness.

## Verification

The contract suite is self-validated against a reference in-memory provider
and consumed by both implementations; outage tests assert the full
transition chain (healthy→degraded→unavailable→recovered) against the
durable stream; the HTTP contract is pinned by a reference server running
the wire round-trip; fake-clock tests cover weeks-later recall with
mid-course corrections and expired valid-time facts.
