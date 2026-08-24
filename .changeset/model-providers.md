---
'@bee-agent/model-providers': minor
'@bee-agent/server': minor
---

Added real model providers over the OpenAI-compatible HTTP surface (ADR 0013).

- `@bee-agent/model-providers` (new): `OpenAIChatAgent` implements the runtime `Agent` contract against `POST /chat/completions` with a bounded turn loop — model text becomes `agent.message` events, tool calls go through the runtime's policy-intercepted `callTool` with sanitized function names mapped back to tool ids, results are fed back as tool messages, and cancellation is honoured between turns. `OpenAIEmbedder` implements `Embedder` against `POST /embeddings` with a declared-dimensions space, index-based ordering, and dimension-drift rejection. Both inject their fetch (tests run with no network) and map failures to `ModelProviderError`/`ModelProtocolError`.
- `@bee-agent/server`: `embedder` option feeds the memory runtime a real embedder; `main.ts` wires both providers from `BEE_AGENT_MODEL_PROVIDER/BASE_URL/API_KEY/MODEL[/SYSTEM_PROMPT]` and `BEE_AGENT_EMBEDDING_PROVIDER/BASE_URL/API_KEY/MODEL/DIMENSIONS` environment variables — keys arrive via environment only and are never persisted. Verified live against DeepSeek (`deepseek-chat`): plain chat replies and a full calculator tool-call round trip (model calls the tool, runtime executes it, model answers with the result).
