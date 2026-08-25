---
'@bee-agent/thread': minor
---

Add loop-authored events to the Thread–Turn–Item protocol: `agent.checkpoint` (stepIndex plus a state digest, marking that every step effect before it is durable) and `turn.cancelled`. The approval item payload also gains optional `approvalId`/`callId`/`toolId` so a suspended turn's pending tool call can be recovered durably after a crash.
