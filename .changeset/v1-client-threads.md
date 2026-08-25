---
'@bee-agent/client': major
---

Rewrite the client SDK against the Personal Bee Host's `/threads` API. `createThread` creates a thread, `createTurn` starts a turn, `resolveApproval` resumes a suspended turn, and `streamItems` streams wire thread events over SSE with `Last-Event-ID` recovery. The SDK now depends only on the dependency-free `@bee-agent/thread/protocol` surface (plus zod), so browser clients no longer pull the Chronicle/kernel node builtins. The v0 task/approval/memory methods are gone.
