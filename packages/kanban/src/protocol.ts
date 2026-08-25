import { z } from 'zod'

/**
 * The Kanban domain model (architecture §15.2): the durable task card that
 * lives independently of any Thread, plus every field it needs for goal,
 * acceptance, dependencies, provenance, workspace, capability, budget,
 * scheduling, idempotency, claim lease, and artifact/trajectory links. This
 * module imports nothing but zod so it stays a leaf type surface.
 */

export const KanbanTaskIdSchema = z.uuid()
export type KanbanTaskId = z.infer<typeof KanbanTaskIdSchema>

/**
 * The recommended task machine (architecture §15.2): the active flow
 * `inbox → triaged → ready → running → blocked/review → done`, with
 * `failed` / `cancelled` / `archived` as terminal states reachable from
 * every active state. The full transition table lives in `state-machine.ts`.
 */
export const KANBAN_TASK_STATUSES = [
  'inbox',
  'triaged',
  'ready',
  'running',
  'blocked',
  'review',
  'done',
  'failed',
  'cancelled',
  'archived',
] as const
export type KanbanTaskStatus = (typeof KANBAN_TASK_STATUSES)[number]
export const KanbanTaskStatusSchema = z.enum(KANBAN_TASK_STATUSES)

export const KANBAN_PRIORITIES = [
  'lowest',
  'low',
  'medium',
  'high',
  'urgent',
] as const
export type KanbanPriority = (typeof KANBAN_PRIORITIES)[number]
export const KanbanPrioritySchema = z.enum(KANBAN_PRIORITIES)

/**
 * A dependency on another task. `satisfiedWhen` is the status the referenced
 * task must reach before this one becomes runnable; it defaults to `done`
 * when omitted.
 */
export const KanbanDependencyKindSchema = z.enum(['blocks', 'related'])
export type KanbanDependencyKind = z.infer<typeof KanbanDependencyKindSchema>

export const KanbanDependencySchema = z.object({
  taskId: KanbanTaskIdSchema,
  kind: KanbanDependencyKindSchema,
  satisfiedWhen: KanbanTaskStatusSchema.optional(),
})
export type KanbanDependency = z.infer<typeof KanbanDependencySchema>

/** Where the task came from: a thread, and optionally the turn inside it. */
export const KanbanSourceSchema = z.object({
  threadId: z.uuid(),
  turnId: z.uuid().optional(),
})
export type KanbanSource = z.infer<typeof KanbanSourceSchema>

export const KanbanWorkspaceSchema = z.object({
  workspaceId: z.string().min(1),
  path: z.string().optional(),
})
export type KanbanWorkspace = z.infer<typeof KanbanWorkspaceSchema>

/** Resource budget for one execution attempt of the task. */
export const KanbanBudgetSchema = z.object({
  maxTokens: z.number().int().positive().optional(),
  maxCostCents: z.number().int().nonnegative().optional(),
  maxDurationMs: z.number().int().positive().optional(),
})
export type KanbanBudget = z.infer<typeof KanbanBudgetSchema>

/**
 * The claim lease held by the worker currently executing a `running` task.
 * `leaseId` is the fencing token; the dispatcher (Phase 2 P2-2) owns
 * claiming, heartbeat renewal, and expiry.
 */
export const KanbanClaimLeaseSchema = z.object({
  claimant: z.string().min(1),
  leaseId: z.uuid(),
  claimedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
})
export type KanbanClaimLease = z.infer<typeof KanbanClaimLeaseSchema>

/**
 * A pinned reference to an artifact or trajectory: `id` is a content digest
 * for artifacts, or an episode/trajectory id for trajectories; `version`
 * discriminates attempts.
 */
export const KanbanRefSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
})
export type KanbanRef = z.infer<typeof KanbanRefSchema>

/**
 * A note attached to a task. Comments are annotations, not state: they are
 * folded into the projection so clients read them alongside the task.
 */
export const KanbanCommentSchema = z.object({
  id: z.uuid(),
  author: z.string().min(1),
  body: z.string().min(1),
  at: z.iso.datetime(),
})
export type KanbanComment = z.infer<typeof KanbanCommentSchema>

const IsoDateTime = z.iso.datetime()

/**
 * `KanbanTask`: the full durable card (architecture §15.2). `version` starts
 * at 1 and increments on every mutation; optimistic concurrency is enforced
 * by {@link applyTransition} comparing it against the caller's
 * `expectedVersion`.
 */
export const KanbanTaskSchema = z.object({
  id: KanbanTaskIdSchema,
  title: z.string().min(1),
  goal: z.string().min(1).optional(),
  acceptanceCriteria: z.array(z.string().min(1)),
  priority: KanbanPrioritySchema,
  labels: z.array(z.string().min(1)),
  dependencies: z.array(KanbanDependencySchema),
  source: KanbanSourceSchema.optional(),
  workspace: KanbanWorkspaceSchema.optional(),
  requiredCapabilities: z.array(z.string().min(1)),
  budget: KanbanBudgetSchema.optional(),
  scheduledAt: IsoDateTime.optional(),
  deadline: IsoDateTime.optional(),
  idempotencyKey: z.string().min(1).optional(),
  status: KanbanTaskStatusSchema,
  claim: KanbanClaimLeaseSchema.optional(),
  artifactRefs: z.array(KanbanRefSchema),
  trajectoryRefs: z.array(KanbanRefSchema),
  comments: z.array(KanbanCommentSchema),
  version: z.number().int().positive(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  endedAt: IsoDateTime.optional(),
})
export type KanbanTask = z.infer<typeof KanbanTaskSchema>
