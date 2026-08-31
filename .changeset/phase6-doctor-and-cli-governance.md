---
'@bee-agent/client': minor
'@bee-agent/bee': minor
'@bee-agent/cli': minor
---

Phase 6 first slice: `bee doctor` and CLI governance over the new
capability surfaces. A new `GET /diagnostics` endpoint summarizes every
subsystem in one call — overall status, structure (active version, restart
requirements, kernel doctor, config source), memory (health plus claim
counts), world projection, scheduler, learning (proposals by status, loop
and drift budgets), and thread count — degrading to `degraded` when memory
is unavailable and never letting a provider outage fail the probe. The
client SDK gains diagnostics plus the memory-governance
(list/forget/consolidate) and learning-governance (run/list/show/experiment/
transition/monitor) method families. The CLI adds `bee doctor`,
`bee memory list|forget|consolidate`, and the full `bee learning`
lifecycle (run/list/show/experiment/review/trial/promote/reject/rollback/
monitor) — the governance arc from Phase 5 is now operable without curl.
