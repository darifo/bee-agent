---
'@bee-agent/context': minor
---

Land the Tool Index/Resolver with two-stage loading (v1 refactor plan §5.2 P2-8).

- Tool model (`tool.ts`): `ToolSpec` (id, description, input JSON Schema), `ToolDefinition` (spec + tags + resident flag), and `ToolSummary` for the lazy-loadable index, with `estimateToolTokens` / `estimateToolSummaryTokens` / `measureToolContextCost`.
- `ToolRegistry` (`tool-registry.ts`) implements `ToolIndex.search(query, budget)` and `ToolResolver.resolve(ids)`: resident core tools always expose their full specs, long-tail tools (MCP, external APIs) are searched by summary and resolved within a token budget, and duplicate ids fail loud. Resolved specs are immutable snapshots, so a turn pins the tool versions it started with.
