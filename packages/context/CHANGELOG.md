# @bee-agent/context

## 0.2.0

### Minor Changes

- 1e2c0de: Land context budget and compression (v1 refactor plan §5.2 P2-6).

  - `allocateContextBudget`: assembles the model context under a token budget in §10.4 priority order, always keeping protected content — pending approvals, unconsumed tool results, active plan constraints, failure reasons, artifact references, memory provenance, and permission boundaries — even when that pushes the total over budget, and recording every drop as an omission.
  - `truncatingCompression`: a deterministic compression baseline (head retained, tail elided) standing in for a real summarizer.
  - `compileContextManifest`: the full pipeline that compresses unprotected overflow, allocates the budget, and builds a `ContextManifest` whose sections and omissions explain exactly where the tokens went.

- c6924a4: Land the Context Manifest (architecture §10.3). `buildContextManifest` records a model call's input as sections with source ids, renderer version, priority, a token estimate, and a content digest; `rebuildContextInput` renders each section from its source + renderer and re-checks the digest, throwing `ContextReconstructionError` on drift. `context.manifest` events persist the manifest into Chronicle keyed to the thread/turn/structure version. Token estimation is a deterministic characters-over-four stand-in until Phase 2 swaps in a real tokenizer.
- 7460bb1: Scaffolded the six new v1 core packages (ADR 0018, refactor plan §3.1) as empty skeletons: package boundary, exports, build/typecheck/test wiring, and a documented placeholder for the public surface.

  - `@bee-agent/thread` will carry the Thread–Turn–Item interaction protocol (Phase 1).
  - `@bee-agent/kanban` will carry the durable task plane: model, state machine, store contracts, claim/lease, dispatcher (Phase 2).
  - `@bee-agent/context` will carry prompt sections, context budgets, compression, the Skill registry, and tool index/resolver (Phase 2).
  - `@bee-agent/knowledge` will carry the Chronicle envelope, ChronicleStore contracts, world/structure projections, and memory provider contracts (Phase 1+).
  - `@bee-agent/execution` will carry the capability pipeline, permissions, approvals, secret brokering, ExecutionWorld/sandbox, and artifact contracts (Phase 3).
  - `@bee-agent/learning` will carry derivers, consolidators, skill learning, proposals, experiments, and evaluation (Phase 5).

- 61eeadb: Land the Skill Registry with two-stage loading (v1 refactor plan §5.2 P2-7).

  - Skill manifest/summary model (`skill.ts`): a full `Skill` (name, version, summary, description, tags, risk level, required capabilities/permissions, input/output schemas, eval cases, known failure modes) plus a cheap `SkillSummary` for the index stage, with `estimateSkillTokens`/`estimateSummaryTokens` for token budgeting.
  - `SkillRegistry` (`skill-registry.ts`): `index()` exposes only summaries so unmatched skills cost almost nothing; `resolve`/`resolveMany` load the full skill after a match; `search` finds candidates. Duplicate skill ids fail loud.
  - Basic eval skeleton: `evaluateSkill` runs every eval case against an injected evaluator and reports pass/fail with actual/expected outputs.

- edbe21b: Land the token baseline benchmark (v1 refactor plan §5.2 P2-10).

  - `measureTokenBaseline` compares the naive full context (all history + full tool specs + full skills) against the budgeted + two-stage context (budgeted history, resident tools + long-tail summaries, skill summaries), reporting per-dimension token counts and a savings ratio.
  - `GOLDEN_SCENARIOS` + `runTokenBaseline` run the fixed golden set; a test asserts the savings ratio stays below the CI threshold, so a context-efficiency regression fails the build.

- a5553f1: Land the Tool Index/Resolver with two-stage loading (v1 refactor plan §5.2 P2-8).

  - Tool model (`tool.ts`): `ToolSpec` (id, description, input JSON Schema), `ToolDefinition` (spec + tags + resident flag), and `ToolSummary` for the lazy-loadable index, with `estimateToolTokens` / `estimateToolSummaryTokens` / `measureToolContextCost`.
  - `ToolRegistry` (`tool-registry.ts`) implements `ToolIndex.search(query, budget)` and `ToolResolver.resolve(ids)`: resident core tools always expose their full specs, long-tail tools (MCP, external APIs) are searched by summary and resolved within a token budget, and duplicate ids fail loud. Resolved specs are immutable snapshots, so a turn pins the tool versions it started with.

### Patch Changes

- Updated dependencies [9be74e1]
- Updated dependencies [34d0d4f]
- Updated dependencies [6c62bd0]
- Updated dependencies [e359897]
- Updated dependencies [e359897]
- Updated dependencies [cdcba95]
- Updated dependencies [066bd78]
- Updated dependencies [4c7f805]
- Updated dependencies [7460bb1]
- Updated dependencies [4ebc68b]
- Updated dependencies [b67f04a]
- Updated dependencies [149fddf]
  - @bee-agent/kernel@1.0.0
  - @bee-agent/knowledge@0.2.0
