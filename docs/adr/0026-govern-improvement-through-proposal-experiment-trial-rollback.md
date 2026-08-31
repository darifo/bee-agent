# ADR 0026: Govern improvement through Proposal–Experiment–Trial–Rollback

> Status: Accepted and implemented
>
> Date: 2026-08-31

## Context

An agent that can improve itself without governance invites reward
hacking, self-poisoning, catastrophic forgetting, and uncontrolled drift
(architecture §11.5). Unauditable "optimization suggestions" are worse
than none: they either do nothing or do something nobody can explain or
undo.

## Decision

Every improvement is a structured `ImprovementProposal` carrying a
hypothesis, trajectory provenance, expected benefits, risks, an evaluation
plan, a rollback plan, and an autonomy level (L0–L3). The lifecycle is
`draft → testing → review → trial → promoted` with `rejected` and
`rolled-back` terminals, guarded by optimistic concurrency and illegal-
transition rejection:

- **Experiment before approval**: ExperimentWorld freezes a digest-pinned
  dataset of derived trajectories, runs an injectable evaluator in
  isolation, and emits a report with a content-addressed changeset and a
  type-specific rollback package. The default evaluator recomputes the
  proposal's claimed pattern from the frozen data — the evidence gate
  auto-archives claims the data does not support, so the loop cannot
  launder invented evidence through its own experiments.
- **Approval is the user's**: promoting activates the change through a
  governed channel (the activation claim cites the
  `learning.proposal.activated` stream position as provenance and is
  recalled into subsequent turns — a real behavior change). The loop may
  never exceed autonomy L2; L0 summaries never activate; L3 code changes
  fail closed until the worktree ChangeSet pipeline exists. The root trust
  zone (security policy, audit, credentials, stable structure) is never
  self-modifiable.
- **Rollback is one click and automatic under drift**: rolling back a
  promoted proposal retracts the activation durably; the drift monitor
  compares post-adoption real turns (the holdout the proposal never saw)
  against the immutable pre-adoption baseline and auto-rolls-back
  regressions with the numbers in the durable reason. A change budget caps
  simultaneously active activations.

## Consequences

- Improvement is slower than direct self-modification — deliberately: every
  change is evidenced, user-approved, effective, and reversible, with
  numbers in the audit trail rather than prose.
- Richer evaluation (counterfactual replay, adversarial samples, holdout
  scoring, source weighting) extends the Evaluator seam without changing
  the governance spine.
- The exit criterion "a real-trajectory candidate passes isolated
  evaluation, improves tasks after user approval, and can be withdrawn"
  is enforceable by test and by demonstration.

## Verification

Package tests cover the lifecycle, evidence gate (accept/reject paths),
activation/rollback, drift regression with numeric reasons, and the change
budget; host integration tests drive the full arc; the Phase 5 exit
demonstration runs it on a live Host with a real model.
