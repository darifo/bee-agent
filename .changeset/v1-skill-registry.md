---
'@bee-agent/context': minor
---

Land the Skill Registry with two-stage loading (v1 refactor plan §5.2 P2-7).

- Skill manifest/summary model (`skill.ts`): a full `Skill` (name, version, summary, description, tags, risk level, required capabilities/permissions, input/output schemas, eval cases, known failure modes) plus a cheap `SkillSummary` for the index stage, with `estimateSkillTokens`/`estimateSummaryTokens` for token budgeting.
- `SkillRegistry` (`skill-registry.ts`): `index()` exposes only summaries so unmatched skills cost almost nothing; `resolve`/`resolveMany` load the full skill after a match; `search` finds candidates. Duplicate skill ids fail loud.
- Basic eval skeleton: `evaluateSkill` runs every eval case against an injected evaluator and reports pass/fail with actual/expected outputs.
