# ADR 0013: Use OpenAI-compatible HTTP for model providers

## Background

The task runtime and memory runtime define `Agent` and `Embedder` contracts but shipped only deterministic mocks; real deployments need hosted models, and the first target is DeepSeek.

## Decision

Implement real model providers in `@bee-agent/model-providers` against the OpenAI-compatible HTTP surface only — `POST /chat/completions` for `OpenAIChatAgent` and `POST /embeddings` for `OpenAIEmbedder` — configured by base URL, API key, and model name. Providers are plain classes wired by the composition root from `BEE_AGENT_MODEL_*` / `BEE_AGENT_EMBEDDING_*` environment variables; keys are never persisted.

## Reasons

One wire protocol covers DeepSeek, OpenAI, and every compatible gateway; the contracts stay dependency-free (global fetch); tool calling rides the standard function-calling fields with a sanitized-name mapping back to tool ids; embedder dimensions are declared up front so the Vector Store's embedding-space validation polices provider drift.

## Alternatives

Per-vendor SDKs (dependency sprawl, inconsistent versions), a local inference plugin first (heavier than the HTTP contract), or streaming-first agents (the current `Agent` contract is turn-based; streaming can be added later behind the same boundary).

## Positive impact

Any OpenAI-compatible provider works with zero code changes; tests run against an injected fetch with no network; cancellation, policy interception, and event sourcing keep working because the agent only uses the runtime's own context APIs.

## Negative impact

Non-OpenAI-compatible providers need adapters later; turn-based loops pay one round trip per tool round; provider quirks beyond the shared surface (reasoning fields, provider-specific tool options) are invisible.

## Follow-up constraints

Streaming replies and per-task agent selection (multiple registered providers) extend this boundary without replacing it; secrets remain environment-only.
