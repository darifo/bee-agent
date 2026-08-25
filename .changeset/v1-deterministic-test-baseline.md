---
'@bee-agent/kernel': minor
---

Added the deterministic test baseline behind a `@bee-agent/kernel/testing` subpath export (v1 refactor plan §4.2).

- `Clock` interface plus `FakeClock`: manually advanced time with a deterministic timer queue — `schedule` mirrors `setTimeout`, `advance` fires due timers in (time, id) order including timers chained while advancing, and canceled timers never run.
- `createFakeTool`: scriptable tool that records every invocation and echoes input by default, for asserting loop/tool-pipeline behavior without real capabilities.
- `createScriptedModel`: provisional model double that issues scripted decisions (`text` / `tool-call` / `error`) in order and rejects loudly when the script runs dry; it will conform to the Phase 1 `LLMRuntime` contract.
