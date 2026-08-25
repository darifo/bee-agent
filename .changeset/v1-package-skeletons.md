---
'@bee-agent/thread': minor
'@bee-agent/kanban': minor
'@bee-agent/context': minor
'@bee-agent/knowledge': minor
'@bee-agent/execution': minor
'@bee-agent/learning': minor
---

Scaffolded the six new v1 core packages (ADR 0018, refactor plan §3.1) as empty skeletons: package boundary, exports, build/typecheck/test wiring, and a documented placeholder for the public surface.

- `@bee-agent/thread` will carry the Thread–Turn–Item interaction protocol (Phase 1).
- `@bee-agent/kanban` will carry the durable task plane: model, state machine, store contracts, claim/lease, dispatcher (Phase 2).
- `@bee-agent/context` will carry prompt sections, context budgets, compression, the Skill registry, and tool index/resolver (Phase 2).
- `@bee-agent/knowledge` will carry the Chronicle envelope, ChronicleStore contracts, world/structure projections, and memory provider contracts (Phase 1+).
- `@bee-agent/execution` will carry the capability pipeline, permissions, approvals, secret brokering, ExecutionWorld/sandbox, and artifact contracts (Phase 3).
- `@bee-agent/learning` will carry derivers, consolidators, skill learning, proposals, experiments, and evaluation (Phase 5).
