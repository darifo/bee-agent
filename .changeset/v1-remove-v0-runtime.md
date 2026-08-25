---
'@bee-agent/runtime': major
---

Remove the v0 task runtime: `TaskRuntime`, `task-events`, `task-state-machine`, `MockAgent`, `MemoryRuntime`, and their `Agent`/`Tool`/`ToolRegistry`/`ToolPolicy`/`Embedder`/`memory-chunker` infrastructure are deleted. The runtime package now exposes only the v1 `AgentLoop` and `LlmRuntime` surface.
