# @bee-agent/memory-bee

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

### Patch Changes

- Updated dependencies [34d0d4f]
- Updated dependencies [6c62bd0]
- Updated dependencies [e359897]
- Updated dependencies [7460bb1]
- Updated dependencies [149fddf]
  - @bee-agent/knowledge@0.2.0
