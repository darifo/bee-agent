---
'@bee-agent/runtime': minor
'@bee-agent/bee': minor
---

Add the durable agent scheduler (Phase 4 WF4-F core): one-shot and recurring
triggers that continue a bound thread across days and restarts. Trigger state
lives on a serialized `scheduler` Chronicle stream (registered/triggered/
removed events) and rebuilds on restart; ticks fire due triggers under a
fire-once catch-up policy that collapses missed intervals into one run —
reporting how many were skipped and resuming on the original cadence. Turns
launched by the scheduler are marked with trigger `schedule`, and a crashing
turn still advances the schedule (no hot loops). The Host enables the
scheduler by default (5s auto-tick) and exposes `/scheduler/triggers` CRUD
plus a manual `POST /scheduler/tick`.
