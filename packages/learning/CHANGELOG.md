# @bee-agent/learning

## 0.3.0

### Minor Changes

- ffc451d: Phase 5 WF5-D: autonomy-level activation makes approval take effect. A
  promoted L1/L2 proposal now activates immediately through the governed
  memory channel — the activation claim is recalled into subsequent turns, so
  promotion is a real behavior change — and records a durable
  `learning.proposal.activated` fact whose stream position becomes the
  claim's provenance. Rolling back a promoted proposal is one click too: the
  activation claim is retracted and `learning.proposal.activation-reverted`
  persists. Autonomy levels are enforced, not advisory: L0 proposals are
  evidence summaries and never activate; L3 requires the worktree ChangeSet
  pipeline and fails closed until it exists. Activation state rebuilds from
  the learning stream after restart. `POST /learning/proposals/:id/activate`
  is the idempotent retry path; the background learning cadence now also
  performs the L1-class memory consolidation after each loop run.
- ee86e09: Phase 5 WF5-E: drift monitoring with automatic rollback, plus the change
  budget. After a proposal is promoted and activated, real turns that arrive
  are the holdout the proposal never saw: `DriftMonitor` re-derives the
  pre-adoption evidence turns (immutable in Chronicle) as the baseline,
  derives the post-activation window, and compares the target metric — tool
  failure rate for skill/guardrail proposals, average checkpoints for
  planning ones. Regression beyond the budget margins rolls the proposal
  back automatically with the numbers in the durable reason, and every check
  appends a `learning.drift.checked` fact so even quiet windows stay
  auditable. Insufficient samples never judge. The Host runs the monitor on
  the learning cadence and auto-retracts activations for rolled-back
  proposals; `POST /learning/monitor` runs it on demand. The activation
  service enforces a change budget (default 5 simultaneously active
  activations) against uncontrolled drift — reaching it requires rolling one
  back first.
- 6ffcb88: Phase 5 WF5-C: ExperimentWorld, where proposals earn their evidence. Each
  experiment freezes a dataset of derived trajectories (digest-pinned over
  content, so later conversation activity cannot drift what is tested), runs
  an injectable evaluator in isolation — read-only facts, no
  memory/structure/behavior writes — and emits a durable report with a
  content-addressed changeset and a type-specific rollback package. The
  default `evidence-verify@1` evaluator recomputes the proposal's claimed
  pattern directly from the frozen data: inflated or invented claims are
  rejected by the evidence gate, which archives the proposal automatically;
  passing evidence waits in review for the user. Evaluator infrastructure
  failures persist a `learning.experiment.failed` fact and leave the proposal
  in testing for retry. Host routes: `POST
/learning/proposals/:id/experiment` and `GET
/learning/proposals/:id/experiments`.
- 260d4d7: Phase 5 foundation: the slow loop and governed ImprovementProposals. The
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

## 0.2.0

### Minor Changes

- 7460bb1: Scaffolded the six new v1 core packages (ADR 0018, refactor plan §3.1) as empty skeletons: package boundary, exports, build/typecheck/test wiring, and a documented placeholder for the public surface.

  - `@bee-agent/thread` will carry the Thread–Turn–Item interaction protocol (Phase 1).
  - `@bee-agent/kanban` will carry the durable task plane: model, state machine, store contracts, claim/lease, dispatcher (Phase 2).
  - `@bee-agent/context` will carry prompt sections, context budgets, compression, the Skill registry, and tool index/resolver (Phase 2).
  - `@bee-agent/knowledge` will carry the Chronicle envelope, ChronicleStore contracts, world/structure projections, and memory provider contracts (Phase 1+).
  - `@bee-agent/execution` will carry the capability pipeline, permissions, approvals, secret brokering, ExecutionWorld/sandbox, and artifact contracts (Phase 3).
  - `@bee-agent/learning` will carry derivers, consolidators, skill learning, proposals, experiments, and evaluation (Phase 5).
