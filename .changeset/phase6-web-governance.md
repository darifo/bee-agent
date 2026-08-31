---
'@bee-agent/client': minor
'@bee-agent/web': minor
---

Phase 6 WF6-B: governance views in the web console. A Memory panel lists
what Bee remembers with status badges and one-click Forget (backed by the
durable retraction) plus Consolidate; a Learning panel runs the slow loop,
fires the isolated experiment, and drives the full governance lifecycle
(review → trial → promote → rollback) over the same routes the CLI uses,
with drift checks on demand. The client SDK exports the Diagnostics,
MemoryClaimDto, LearningProposalDto, and LearningTransitionInput types the
views consume. The Phase 5 governance arc is now operable from chat, CLI,
and browser alike.
