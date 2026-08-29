---
'@bee-agent/runtime': minor
---

Context compaction, level 1: old tool results are elided from the model-visible request under a token budget (benchmark-driven hardening pass, step 4).

- New `context-policy` module: `projectHistory(history, policy)` folds the model view — tool results beyond `toolResultBudgetTokens` (default 4096) and outside the `keepRecentToolResults` window (default 4) become a deterministic placeholder carrying the original token count, tool id, and content digest. Error results are protected (failure reasons are what the model must still see), as is the recent window where the model is working. The projection is pure: `state.history` keeps full fidelity, checkpoint digests keep rebuilding from Chronicle unchanged, and recovery re-derives the same view deterministically (the dsh surface-fold approach — fold the view, never the log).
- The AgentLoop applies the projection to every assembled request; `ModelRequestService` records each elision as a manifest omission (`context-policy:tool-result-budget`), so the existing request-replay audit shows exactly what the model stopped seeing and why.
- Tunable per loop via `AgentLoopOptions.toolResultCompaction`; exported as `DEFAULT_TOOL_RESULT_COMPACTION` / `projectHistory` for host wiring. Covered by unit tests, an AgentLoop integration test (Chronicle keeps full content while the model sees placeholders), and a recorded replay fixture pinning the elision progression across a multi-tool session.
