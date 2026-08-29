---
'@bee-agent/runtime': minor
'@bee-agent/model-providers': minor
'@bee-agent/thread': minor
---

Hardened the model interaction boundary of the AgentLoop (P0 of the benchmark-driven hardening pass).

- `@bee-agent/model-providers`: `OpenAIChatRuntime` now streams for real — `stream: true` + `stream_options.include_usage`, SSE parsing that pushes `message-delta` events as chunks arrive, tool intents assembled from streamed argument fragments, and a buffered-JSON fallback when a provider or proxy answers without `text/event-stream` (or `streaming: false` is set). Request timeouts cover headers only, so long streams are not killed mid-flight. `Retry-After` is parsed into `LlmRuntimeError.retryAfterMs`, and malformed tool arguments are surfaced as `inputError` on the call instead of silently executing with `{}`.
- `@bee-agent/runtime` (AgentLoop): retries back off (Retry-After, then exponential, cap 30s) instead of hammering the provider; message deltas are buffered before hitting Chronicle (256-char flush) so real streaming does not become one write per chunk; a throwing tool or malformed-arguments call is isolated as an `isError` tool result the model can react to instead of failing the turn — recorded as `item.completed` so checkpoint digests stay rebuildable; `max_tokens` doubles the output cap (bounded by the model maximum) and regenerates the step, and only fails with a clear error when the maximum is already reached. `ModelRequestService.capabilities()` exposes the bound model's limits to the loop.
- `@bee-agent/thread`: tool-call payloads and assistant `toolCalls` carry an optional `inputError` for provider-detected malformed arguments.
