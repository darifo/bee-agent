---
'@bee-agent/model-providers': major
---

Rewrite the OpenAI chat provider as a stateless `OpenAIChatRuntime` implementing the v1 `LlmRuntime` contract (architecture §10.2). Each `generate` call takes a fully assembled ContextBundle and returns one in-flight call: message deltas, tool intents, and structured decisions stream out, and the result reports usage, stop reason, provider id, and latency. There is no message history on the instance and no internal tool loop — the AgentLoop decides what runs next. Provider failures are classified into `LlmRuntimeError` retryability (`retryable`/`fatal`/`context-overflow`), cancellation settles `stopReason: 'cancelled'`, and capabilities report token limits. The v0 `OpenAIChatAgent` is removed.
