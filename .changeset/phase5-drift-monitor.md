---
'@bee-agent/learning': minor
'@bee-agent/bee': minor
---

Phase 5 WF5-E: drift monitoring with automatic rollback, plus the change
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
