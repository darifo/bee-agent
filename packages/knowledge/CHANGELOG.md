# @bee-agent/knowledge

## 0.2.0

### Minor Changes

- 34d0d4f: Add the Phase 4 personal memory foundation: the MemoryProvider contract with
  Claim/Observation/Representation schemas and a Chronicle-backed contract suite
  in knowledge; the embedded `memory-bee` provider (durable `memory` stream
  projection, lexical recall with CJK bigrams, deterministic preference/correction
  derivation, duplicate consolidation); AgentLoop retrieve-hook recall and a
  near-line derivation worker in runtime; and Host wiring with memory governance
  routes (`GET /memory/claims`, `POST /memory/claims/:id/retract`,
  `POST /memory/consolidate`, `GET /memory/export`), the Goal/Plan hook, and
  optional `BEE_AGENT_STRUCTURE_FILE` hot reload.
- 6c62bd0: Add explicit remote-memory degradation: a `memory.health.changed` Chronicle
  event records every provider health transition; `MemoryProviderUnavailableError`
  enables fail-fast calls; the new `@bee-agent/memory-remote` package provides
  the bridge transport seam (with an in-process SDK bridge) and
  `RemoteMemoryProvider` with a consecutive-failure circuit breaker whose
  recovery runs through health probes. The recall hook now skips gracefully when
  a circuit opens mid-call. Phase 4 CI gates land with this slice: conflicting
  claims stay visible until corrected, a reference in-memory provider
  self-validates the contract suite, and a fake-clock test covers weeks-later
  recall with corrections and expired valid-time facts.
- e359897: Record resolved structures in Chronicle. The new `structure.resolved` event type carries the full effective structure, its digest, and the bundle chain; the envelope's `structureVersion` field carries the digest so later events tie back to the structure they ran under. `appendResolvedStructure` writes to the `structure` stream, deduplicating unchanged digests (only actual structure changes create versions) and honoring explicit `expectedSequence` for caller-managed concurrency.
- 7460bb1: Scaffolded the six new v1 core packages (ADR 0018, refactor plan §3.1) as empty skeletons: package boundary, exports, build/typecheck/test wiring, and a documented placeholder for the public surface.

  - `@bee-agent/thread` will carry the Thread–Turn–Item interaction protocol (Phase 1).
  - `@bee-agent/kanban` will carry the durable task plane: model, state machine, store contracts, claim/lease, dispatcher (Phase 2).
  - `@bee-agent/context` will carry prompt sections, context budgets, compression, the Skill registry, and tool index/resolver (Phase 2).
  - `@bee-agent/knowledge` will carry the Chronicle envelope, ChronicleStore contracts, world/structure projections, and memory provider contracts (Phase 1+).
  - `@bee-agent/execution` will carry the capability pipeline, permissions, approvals, secret brokering, ExecutionWorld/sandbox, and artifact contracts (Phase 3).
  - `@bee-agent/learning` will carry derivers, consolidators, skill learning, proposals, experiments, and evaluation (Phase 5).

- 149fddf: Add the WorldModel foundation (Phase 4 WF4-D): world entities, provenance-
  carrying relations, and versioned snapshots in knowledge, with a serialized
  `world` Chronicle stream whose version bumps carry a digest of the full
  projected state — rebuilds verify every digest and fail loud on drift. A
  sourced `WorldProjector` seam derives facts only from Chronicle events (the
  bundled `ThreadToolProjector` records agent-to-tool usage with exact item
  provenance); unevidenced assertions cannot enter the model. The Host now
  maintains the projection (catch-up replay at start plus live append
  projection) and serves a read-only `GET /world` view with kind/type/entity
  filters.

### Patch Changes

- Updated dependencies [9be74e1]
- Updated dependencies [e359897]
- Updated dependencies [cdcba95]
- Updated dependencies [066bd78]
- Updated dependencies [4c7f805]
- Updated dependencies [4ebc68b]
- Updated dependencies [b67f04a]
  - @bee-agent/kernel@1.0.0
