---
'@bee-agent/runtime': minor
---

Add the LLMRuntime contract (architecture §10.2): a stateless, per-model inference seam. The AgentLoop passes a fully assembled ContextBundle (messages, tool specs, optional decision schema) per call — providers never hold message state. Calls stream message deltas, tool intents, and structured decisions, and settle with a result carrying stop reason, token/cost usage, provider metadata, and latency. Cancellation goes through AbortSignal and settles `stopReason: 'cancelled'`; every failure rejects with `LlmRuntimeError` carrying a retryability classification (`retryable`, `fatal`, `context-overflow`) plus `classifyLlmError` for unclassified errors. Capability discovery exposes streaming/tools/structured-decision support and context/output token limits. `@bee-agent/runtime/testing` ships `createFakeLlmRuntime`, a deterministic scriptable implementation that records calls, honors abort mid-stream, and fails loud on script exhaustion.
