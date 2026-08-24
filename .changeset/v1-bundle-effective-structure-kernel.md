---
'@bee-agent/kernel': minor
---

Add the bundle → EffectiveStructure layer for the single `bee` root profile. `BundleSchema` composes structure references (model, prompt, context policy, memory view, sandbox, eval policy, skills, tools, permissions, budgets) with `includes` for layering; `resolveEffectiveStructure` folds the chain includes-first so the includer wins conflicts, fails loud on cycles, loader mismatches, and unpinned scalar slots, and records provenance (which bundle version contributed each node). The digest is a sha256 over the canonical JSON form, so the same bundle always resolves to the same digest regardless of permission/budget authoring order. Also exports `structureVersionOf` and `traceStructure` for provenance queries.
