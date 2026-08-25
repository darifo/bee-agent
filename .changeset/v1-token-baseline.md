---
'@bee-agent/context': minor
---

Land the token baseline benchmark (v1 refactor plan §5.2 P2-10).

- `measureTokenBaseline` compares the naive full context (all history + full tool specs + full skills) against the budgeted + two-stage context (budgeted history, resident tools + long-tail summaries, skill summaries), reporting per-dimension token counts and a savings ratio.
- `GOLDEN_SCENARIOS` + `runTokenBaseline` run the fixed golden set; a test asserts the savings ratio stays below the CI threshold, so a context-efficiency regression fails the build.
