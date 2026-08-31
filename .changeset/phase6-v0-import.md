---
'@bee-agent/client': minor
'@bee-agent/bee': minor
'@bee-agent/cli': minor
---

Phase 6 WF6-C: the v0 → v1 import tool. `POST /import/v0` (and `bee import
<path>`) reads a v0 SQLite event store read-only and converts each v0 task
into one v1 Chronicle thread: task input becomes the user message, agent
messages become message items, tool traffic becomes tool_call items with
callId-correlated results and isError, approvals become approval items
carrying the decision, and the terminal task state becomes the matching
turn event. Every produced event carries `v0-import` provenance; the v0
task id doubles as the thread id so re-running skips already-imported
threads and reports them. Missing databases are a clean 404.
