---
'@bee-agent/learning': minor
'@bee-agent/bee': minor
---

Phase 5 WF5-C: ExperimentWorld, where proposals earn their evidence. Each
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
