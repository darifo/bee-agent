import { z } from 'zod'

/**
 * The ImprovementProposal domain (architecture §11.3, v1 refactor plan §5.6
 * WF5-B): the only shape a slow-loop insight may take on its way to a real
 * change. A proposal is structured evidence plus a hypothesis — never a
 * direct mutation. The lifecycle follows ADR 0026's
 * Proposal–Experiment–Trial–Rollback arc, and the autonomy level caps what
 * each stage may do without the user.
 */

export const PROPOSAL_TYPES = [
  'memory',
  'knowledge',
  'skill',
  'prompt',
  'context-policy',
  'planning-policy',
  'tool',
  'runtime-structure',
  'world-schema',
  'evaluation',
  'guardrail',
] as const
export type ProposalType = (typeof PROPOSAL_TYPES)[number]
export const ProposalTypeSchema = z.enum(PROPOSAL_TYPES)

export const PROPOSAL_STATUSES = [
  'draft',
  'testing',
  'review',
  'trial',
  'promoted',
  'rejected',
  'rolled-back',
] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]
export const ProposalStatusSchema = z.enum(PROPOSAL_STATUSES)

/** Autonomy levels (architecture §11.4). The loop may never exceed L2. */
export const MAX_LOOP_AUTONOMY_LEVEL = 2
export const AutonomyLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
])
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>

/**
 * Legal lifecycle edges. `draft → review` lets L0 evidence summaries skip
 * experimentation; terminal states never leave.
 */
export const PROPOSAL_TRANSITIONS: Readonly<
  Record<ProposalStatus, readonly ProposalStatus[]>
> = {
  draft: ['testing', 'review', 'rejected'],
  testing: ['review', 'rejected'],
  review: ['testing', 'trial', 'rejected'],
  trial: ['promoted', 'rolled-back'],
  promoted: ['rolled-back'],
  rejected: [],
  'rolled-back': [],
}

export function canTransitionProposal(
  from: ProposalStatus,
  to: ProposalStatus,
): boolean {
  return PROPOSAL_TRANSITIONS[from].includes(to)
}

export class InvalidProposalTransitionError extends Error {
  constructor(
    readonly proposalId: string,
    readonly from: ProposalStatus,
    readonly to: ProposalStatus,
  ) {
    super(`Proposal '${proposalId}' cannot move '${from}' → '${to}'`)
    this.name = 'InvalidProposalTransitionError'
  }
}

/** Trajectory provenance: what evidence the proposal is based on. */
export const TrajectoryRefSchema = z
  .object({
    threadId: z.uuid(),
    turnId: z.uuid(),
  })
  .strict()
export type TrajectoryRef = z.infer<typeof TrajectoryRefSchema>

export const ImprovementProposalSchema = z
  .object({
    id: z.uuid(),
    type: ProposalTypeSchema,
    /** Stable dedupe key for the target, e.g. `skill:lookup`. */
    targetKey: z.string().min(1),
    /** Structure/plugin version the change targets, when applicable. */
    targetVersion: z.string().min(1).optional(),
    basedOnTrajectoryIds: z.array(TrajectoryRefSchema),
    hypothesis: z.string().min(1),
    proposedChange: z.unknown(),
    expectedBenefits: z.array(z.string().min(1)),
    risks: z.array(z.string().min(1)),
    evaluationPlan: z.string().min(1),
    rollbackPlan: z.string().min(1),
    autonomyLevel: AutonomyLevelSchema,
    status: ProposalStatusSchema,
    /** Loop-created proposals are `loop`; hand-written ones are `user`. */
    origin: z.enum(['loop', 'user']),
    version: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
export type ImprovementProposal = z.infer<typeof ImprovementProposalSchema>

export class ProposalVersionConflictError extends Error {
  constructor(
    readonly proposalId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Proposal '${proposalId}' is at version ${actualVersion}, expected ${expectedVersion}`,
    )
    this.name = 'ProposalVersionConflictError'
  }
}

export class ProposalNotFoundError extends Error {
  constructor(readonly proposalId: string) {
    super(`Improvement proposal '${proposalId}' was not found`)
    this.name = 'ProposalNotFoundError'
  }
}

/** Statuses where the proposal is still open for consolidation dedupe. */
export const OPEN_PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  'draft',
  'testing',
  'review',
  'trial',
]
