import { GoalSchema } from './goal-plan.ts'
import type { Goal, PlanStep } from './goal-plan.ts'
import type { GoalPlanStore } from './goal-plan-store.ts'
import type { AgentLoopPlanHook } from './agent-loop.ts'

/**
 * The Goal/Plan planner (architecture §10.1, v1 refactor plan §5.2 P2-5):
 * a deterministic baseline that lets complex tasks "automatically" surface a
 * versioned Plan DAG while simple Q&A produces nothing. The classifier and
 * step derivation are deliberately dumb and injectable — a model-driven
 * planner can replace them without changing the hook or the store.
 */

/** Project verbs that, as the leading word, mark a multi-step task. */
const PROJECT_VERBS = new Set([
  'build',
  'create',
  'implement',
  'migrate',
  'refactor',
  'rewrite',
  'design',
  'research',
  'investigate',
  'integrate',
  'deploy',
  'automate',
  'organize',
  'develop',
  'plan',
])

/** Overt multi-step phrasing, regardless of verb. */
const MULTI_STEP_MARKERS =
  /\b(and then|then|after that|first|second|finally|also|plus|step \d|phase \d|next,)\b/i

/**
 * Deterministic baseline gate: a single short question or imperative is
 * `simple`; multiple sentences, long input, an explicit multi-step phrase,
 * or a leading project verb is `complex` (and therefore planned).
 */
export function classifyTaskComplexity(input: string): 'simple' | 'complex' {
  const trimmed = input.trim()
  if (trimmed === '') return 'simple'
  const sentences = trimmed
    .split(/[.!?]+/)
    .filter((part) => part.trim().length > 0).length
  const words = trimmed.toLowerCase().split(/\s+/)
  if (sentences > 1) return 'complex'
  if (words.length > 40) return 'complex'
  if (MULTI_STEP_MARKERS.test(trimmed)) return 'complex'
  const first = words[0] ?? ''
  if (PROJECT_VERBS.has(first)) return 'complex'
  return 'simple'
}

/** Derives a goal from a complex input; success criteria are filled later. */
export function deriveGoal(threadId: string, input: string, now: string): Goal {
  return GoalSchema.parse({
    id: crypto.randomUUID(),
    threadId,
    statement: input,
    successCriteria: [],
    priority: 'medium',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  })
}

/**
 * A fixed, linear three-phase DAG. The explicit `dependsOn` edges keep the
 * structure real so a smarter planner can later add richer decompositions.
 */
export function derivePlanSteps(): PlanStep[] {
  return [
    {
      id: 'scope',
      description: 'Clarify the goal and its success criteria',
      dependsOn: [],
      status: 'pending',
    },
    {
      id: 'execute',
      description: 'Carry out the work',
      dependsOn: ['scope'],
      status: 'pending',
    },
    {
      id: 'verify',
      description: 'Verify the result against the goal',
      dependsOn: ['execute'],
      status: 'pending',
    },
  ]
}

export interface GoalPlanHookOptions {
  readonly now?: (() => string) | undefined
}

function formatPlanMessage(
  goal: Goal,
  plan: { version: number; steps: readonly PlanStep[] },
): string {
  const lines = plan.steps.map(
    (step, index) =>
      `${index + 1}. ${step.description}` +
      (step.dependsOn.length > 0
        ? ` (after: ${step.dependsOn.join(', ')})`
        : ''),
  )
  return `Goal: ${goal.statement}\nPlan v${plan.version}:\n${lines.join('\n')}`
}

/**
 * The AgentLoop plan hook: on the first step of a complex turn, creates (or
 * reuses) the thread's goal and appends a new plan version, returning a
 * system message that carries the plan. Simple turns and later steps return
 * nothing, so Q&A stays ceremony-free.
 */
export function createGoalPlanHook(
  store: GoalPlanStore,
  options: GoalPlanHookOptions = {},
): AgentLoopPlanHook {
  return {
    async plan(input) {
      if (input.stepIndex > 0) return []
      if (classifyTaskComplexity(input.input) === 'simple') return []
      const now = options.now?.() ?? new Date().toISOString()

      let goal = await store.getGoal(input.threadId)
      if (goal === undefined) {
        goal = deriveGoal(input.threadId, input.input, now)
        await store.upsertGoal(goal)
      }
      const latest = await store.getLatestPlan(goal.id)
      const plan = await store.appendPlan({
        goalId: goal.id,
        steps: derivePlanSteps(),
        ...(latest !== undefined
          ? { revisionReason: 'Revised after further input' }
          : {}),
        now,
      })
      return [{ role: 'system', content: formatPlanMessage(goal, plan) }]
    },
  }
}
