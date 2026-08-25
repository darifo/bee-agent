---
'@bee-agent/runtime': minor
---

Add the AgentLoop minimal core (architecture §10.1/§10.2). The loop owns all message state — the stateless LLMRuntime receives a fully assembled ContextBundle per call. `runTurn` runs the Act/Record loop (generate + tool execution, checkpoint after every durable step, terminal decision on end_turn/decision/max_tokens); tool execution goes through an `AgentLoopToolSlot` seam wired directly in Phase 1 and swapped for ExecutionWorld in Phase 3, and retrieval/planning are left as hook seams for Phase 2. `resumeTurn` suspends and resumes on `approval-required` outcomes, and `recoverTurn` rebuilds the committed history from Chronicle + the last `agent.checkpoint` and continues a crashed turn.
