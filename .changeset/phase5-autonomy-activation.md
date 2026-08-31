---
'@bee-agent/learning': minor
'@bee-agent/bee': minor
---

Phase 5 WF5-D: autonomy-level activation makes approval take effect. A
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
