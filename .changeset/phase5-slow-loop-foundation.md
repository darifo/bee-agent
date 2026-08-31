---
'@bee-agent/learning': minor
'@bee-agent/bee': minor
---

Phase 5 foundation: the slow loop and governed ImprovementProposals. The
new `@bee-agent/learning` package adds the ImprovementProposal domain
(11 change types, the draft→testing→review→trial→promoted/rejected/
rolled-back lifecycle with optimistic concurrency, L0–L3 autonomy levels
where the loop itself may never exceed L2), a `learning` Chronicle stream
with a rebuildable proposal projection, and the budgeted slow loop —
Selection → Derivation → Consolidation → Pattern discovery over recent
tool-using trajectories, with deliberately conservative deterministic
baselines (high-frequency tool usage → skill candidates, repeated tool
failures → guardrail observations, near-cap turn lengths → planning notes),
open-target dedupe, per-run proposal caps, and a durable `learning.loop.run`
audit fact per pass. The Host exposes `/learning/run`, `/learning/budget`,
proposal listing/detail, and user-driven lifecycle transitions (409 on
illegal jumps or stale versions), with an optional background cadence
(default hourly). Integration test drives a real tool-using conversation
into a skill proposal and walks it through review→trial→promoted→
rolled-back.
