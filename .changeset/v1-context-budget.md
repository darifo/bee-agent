---
'@bee-agent/context': minor
---

Land context budget and compression (v1 refactor plan §5.2 P2-6).

- `allocateContextBudget`: assembles the model context under a token budget in §10.4 priority order, always keeping protected content — pending approvals, unconsumed tool results, active plan constraints, failure reasons, artifact references, memory provenance, and permission boundaries — even when that pushes the total over budget, and recording every drop as an omission.
- `truncatingCompression`: a deterministic compression baseline (head retained, tail elided) standing in for a real summarizer.
- `compileContextManifest`: the full pipeline that compresses unprotected overflow, allocates the budget, and builds a `ContextManifest` whose sections and omissions explain exactly where the tokens went.
