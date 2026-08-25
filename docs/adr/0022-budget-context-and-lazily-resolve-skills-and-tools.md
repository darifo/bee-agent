# ADR 0022: Budget Context and Lazily Resolve Skills and Tools

## Background

A model's context window is finite and expensive. Loading every history message, every tool schema, and every skill's full instructions on every call wastes tokens on content the current task does not use. The v1 architecture (§10.3–§10.5) requires the context to be assembled under an explicit budget, with Skills and Tools exposed in two stages so unmatched capabilities cost almost nothing.

## Decision

Context is assembled by a `ContextBudget` that allocates tokens in the §10.4 priority order (safety invariants first, then goal, world, recent items, evidence, skills, tool schemas, and finally history summaries), recording every dropped section as an omission. Skills and Tools are loaded in two stages: an index stage exposes only a summary (stable id, short description, tags, risk level, and a token estimate), and a resolve stage loads the full content only after a match. Core small tools are resident and always loaded; long-tail tools (MCP, external APIs) and Skills are lazy. Compression never removes the protected content — pending approvals, unconsumed tool results, active plan constraints, failure reasons, artifact references, memory provenance, and permission boundaries — even when that pushes the total over budget. The resulting `ContextManifest` records each section's token cost and the omissions, so the spend is auditable.

## Reasons

Two-stage loading is the cheapest way to keep a large capability surface without paying for it: unmatched Skills and Tools cost only a summary line, and the budget makes the assembly order explicit and deterministic rather than an emergent property of ad-hoc concatenation. The omissions and per-section token counts turn "why did the model see this?" into a queryable fact, which the token-baseline benchmark turns into a regression gate.

## Alternatives

Load everything eagerly (simple but pays full cost every call); keep no budget and grow the prompt unbounded (loses determinism and blows latency); or skip the index stage and let the model guess at tool names (no search metadata, no stable ids).

## Positive impact

Token cost drops sharply on the golden workloads (the `token-baseline` CI gate asserts the savings ratio stays below a threshold); Skill/Tool additions stop inflating every turn; the manifest makes omissions and token accounting explainable and replayable.

## Negative impact

A deterministic baseline compressor (head-retained truncation) can lose tail nuance until a real summarizer replaces it; search relevance now decides what gets resolved, so a bad match can hide a needed capability.

## Follow-up constraints

The protected-content list must never be dropped or compressed; resolved Skill/Tool versions are pinned per Turn; the token-baseline benchmark runs in CI and fails when the savings ratio regresses.
