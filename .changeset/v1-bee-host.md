---
'@bee-agent/bee': minor
---

Add the Personal Bee Host minimal form (`apps/bee`, architecture §9.1): one Fastify process serving the Thread–Turn–Item API over a Chronicle store. `POST /threads` creates a thread, `POST /threads/:id/turns` runs the AgentLoop, `POST /threads/:id/turns/:turnId/approvals/:approvalId` resumes a suspended turn, and `GET /threads/:id/items` streams thread events over SSE with `Last-Event-ID` recovery. A `BroadcastingChronicleStore` decorator emits appends so the SSE endpoint follows live events without polling.
