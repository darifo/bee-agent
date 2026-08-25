import { z } from 'zod'

/**
 * Goal and Plan (architecture §8.1, v1 refactor plan §5.2 P2-5): the
 * optional, versioned planning layer above a Thread. A `Goal` is a thread's
 * desired end state with success criteria; a `Plan` is a versioned DAG of
 * steps that decomposes the goal. Simple Q&A never produces these — only
 * tasks the planner classifies as complex do.
 */

export const GoalIdSchema = z.uuid()
export type GoalId = z.infer<typeof GoalIdSchema>

export const PlanIdSchema = z.uuid()
export type PlanId = z.infer<typeof PlanIdSchema>

export const GoalPrioritySchema = z.enum([
  'lowest',
  'low',
  'medium',
  'high',
  'urgent',
])
export type GoalPriority = z.infer<typeof GoalPrioritySchema>

export const GoalStatusSchema = z.enum(['active', 'completed', 'abandoned'])
export type GoalStatus = z.infer<typeof GoalStatusSchema>

const IsoDateTime = z.iso.datetime()

export const GoalSchema = z.object({
  id: GoalIdSchema,
  threadId: z.uuid(),
  /** The desired end state, in the user's words. */
  statement: z.string().min(1),
  /** How completion is recognized; empty until a model-derived plan fills it. */
  successCriteria: z.array(z.string().min(1)),
  priority: GoalPrioritySchema,
  deadline: IsoDateTime.optional(),
  status: GoalStatusSchema,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
})
export type Goal = z.infer<typeof GoalSchema>

export const PlanStepStatusSchema = z.enum([
  'pending',
  'in_progress',
  'done',
  'blocked',
])
export type PlanStepStatus = z.infer<typeof PlanStepStatusSchema>

/** One node in the plan DAG; `dependsOn` lists the step ids it follows. */
export const PlanStepSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  dependsOn: z.array(z.string().min(1)),
  status: PlanStepStatusSchema,
})
export type PlanStep = z.infer<typeof PlanStepSchema>

export const PlanSchema = z.object({
  id: PlanIdSchema,
  goalId: GoalIdSchema,
  /** Monotonic revision number; `appendPlan` assigns `latest + 1`. */
  version: z.number().int().positive(),
  steps: z.array(PlanStepSchema),
  assumptions: z.array(z.string().min(1)),
  revisionReason: z.string().min(1).optional(),
  createdAt: IsoDateTime,
})
export type Plan = z.infer<typeof PlanSchema>
