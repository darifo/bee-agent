---
'@bee-agent/runtime': minor
---

Add the optional Goal/Plan planning layer (v1 refactor plan §5.2 P2-5).

- Versioned Goal/Plan DAG model (`goal-plan.ts`): a thread's `Goal` (statement, success criteria, priority, deadline, status) plus append-only `Plan` revisions whose steps form a DAG through `dependsOn`.
- `GoalPlanStore` contract and `MemoryGoalPlanStore` (`goal-plan-store.ts`) for upserting goals and appending plan versions.
- Deterministic planner (`planner.ts`): `classifyTaskComplexity` gates on a baseline heuristic (short single-sentence Q&A is simple; multi-sentence, long, multi-step, or project-verb requests are complex), `deriveGoal`/`derivePlanSteps` build the goal and a three-phase DAG, and `createGoalPlanHook` is the `AgentLoopPlanHook` that plans only on the first step of a complex turn — simple turns produce no output, so Q&A stays ceremony-free.
