import { PlanSchema } from './goal-plan.ts'
import type { Goal, GoalId, Plan, PlanStep } from './goal-plan.ts'

/**
 * The Goal/Plan store contract (v1 refactor plan §5.2 P2-5): persists a
 * thread's goal and the versioned plan DAGs that decompose it. Plans are
 * append-only revisions; `appendPlan` assigns the next version. An in-memory
 * implementation is the default harness; a Chronicle-backed implementation
 * can replace it without changing the planner or hook.
 */

export interface NewPlanVersionInput {
  readonly goalId: GoalId
  readonly steps: readonly PlanStep[]
  readonly assumptions?: readonly string[] | undefined
  readonly revisionReason?: string | undefined
  readonly now?: string | undefined
}

export interface GoalPlanStore {
  /** The active goal for a thread, or undefined when none has been planned. */
  getGoal(threadId: string): Promise<Goal | undefined>
  getGoalById(goalId: GoalId): Promise<Goal | undefined>
  /** Creates or replaces the goal for its thread. */
  upsertGoal(goal: Goal): Promise<Goal>
  getLatestPlan(goalId: GoalId): Promise<Plan | undefined>
  /** All plan versions for a goal, oldest first. */
  listPlans(goalId: GoalId): Promise<readonly Plan[]>
  /** Appends a new plan version, assigning `version = latest + 1`. */
  appendPlan(input: NewPlanVersionInput): Promise<Plan>
}

export class MemoryGoalPlanStore implements GoalPlanStore {
  readonly #goals = new Map<GoalId, Goal>()
  readonly #goalsByThread = new Map<string, GoalId>()
  readonly #plans = new Map<GoalId, Plan[]>()

  async getGoal(threadId: string): Promise<Goal | undefined> {
    const goalId = this.#goalsByThread.get(threadId)
    return goalId === undefined ? undefined : this.#goals.get(goalId)
  }

  async getGoalById(goalId: GoalId): Promise<Goal | undefined> {
    return this.#goals.get(goalId)
  }

  async upsertGoal(goal: Goal): Promise<Goal> {
    this.#goals.set(goal.id, goal)
    this.#goalsByThread.set(goal.threadId, goal.id)
    return goal
  }

  async getLatestPlan(goalId: GoalId): Promise<Plan | undefined> {
    return this.#plans.get(goalId)?.at(-1)
  }

  async listPlans(goalId: GoalId): Promise<readonly Plan[]> {
    return [...(this.#plans.get(goalId) ?? [])]
  }

  async appendPlan(input: NewPlanVersionInput): Promise<Plan> {
    const versions = this.#plans.get(input.goalId) ?? []
    const version = (versions.at(-1)?.version ?? 0) + 1
    const plan = PlanSchema.parse({
      id: crypto.randomUUID(),
      goalId: input.goalId,
      version,
      steps: [...input.steps],
      assumptions: [...(input.assumptions ?? [])],
      revisionReason: input.revisionReason,
      createdAt: input.now ?? new Date().toISOString(),
    })
    versions.push(plan)
    this.#plans.set(input.goalId, versions)
    return plan
  }
}
