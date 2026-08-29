# @bee-agent/model-providers

## 1.0.0

### Major Changes

- b784d27: Rewrite the OpenAI chat provider as a stateless `OpenAIChatRuntime` implementing the v1 `LlmRuntime` contract (architecture §10.2). Each `generate` call takes a fully assembled ContextBundle and returns one in-flight call: message deltas, tool intents, and structured decisions stream out, and the result reports usage, stop reason, provider id, and latency. There is no message history on the instance and no internal tool loop — the AgentLoop decides what runs next. Provider failures are classified into `LlmRuntimeError` retryability (`retryable`/`fatal`/`context-overflow`), cancellation settles `stopReason: 'cancelled'`, and capabilities report token limits. The v0 `OpenAIChatAgent` is removed.

### Minor Changes

- b1a48bf: Hardened the model interaction boundary of the AgentLoop (P0 of the benchmark-driven hardening pass).

  - `@bee-agent/model-providers`: `OpenAIChatRuntime` now streams for real — `stream: true` + `stream_options.include_usage`, SSE parsing that pushes `message-delta` events as chunks arrive, tool intents assembled from streamed argument fragments, and a buffered-JSON fallback when a provider or proxy answers without `text/event-stream` (or `streaming: false` is set). Request timeouts cover headers only, so long streams are not killed mid-flight. `Retry-After` is parsed into `LlmRuntimeError.retryAfterMs`, and malformed tool arguments are surfaced as `inputError` on the call instead of silently executing with `{}`.
  - `@bee-agent/runtime` (AgentLoop): retries back off (Retry-After, then exponential, cap 30s) instead of hammering the provider; message deltas are buffered before hitting Chronicle (256-char flush) so real streaming does not become one write per chunk; a throwing tool or malformed-arguments call is isolated as an `isError` tool result the model can react to instead of failing the turn — recorded as `item.completed` so checkpoint digests stay rebuildable; `max_tokens` doubles the output cap (bounded by the model maximum) and regenerates the step, and only fails with a clear error when the maximum is already reached. `ModelRequestService.capabilities()` exposes the bound model's limits to the loop.
  - `@bee-agent/thread`: tool-call payloads and assistant `toolCalls` carry an optional `inputError` for provider-detected malformed arguments.

### Patch Changes

- Updated dependencies [b1a48bf]
- Updated dependencies [a2540a2]
- Updated dependencies [34d0d4f]
- Updated dependencies [6c62bd0]
- Updated dependencies [b1a48bf]
- Updated dependencies [b1a48bf]
- Updated dependencies [b1a48bf]
- Updated dependencies [b1a48bf]
- Updated dependencies [85be532]
- Updated dependencies [7cc0dd1]
- Updated dependencies [bedbda4]
- Updated dependencies [e606923]
- Updated dependencies [066bd78]
  - @bee-agent/runtime@1.0.0
