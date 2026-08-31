import { z } from 'zod'
import { newChronicleEvent } from '@bee-agent/knowledge'
import type { ChronicleActor, NewChronicleEvent } from '@bee-agent/knowledge'
import type { ChronicleSchemaRegistry } from '@bee-agent/knowledge'
import { ImprovementProposalSchema } from './proposal.ts'
import type { ImprovementProposal, ProposalStatus } from './proposal.ts'

/**
 * Learning Chronicle events (v1 refactor plan §5.6 WF5-A/WF5-B): every slow
 * loop run and every proposal mutation is a durable fact on one serialized
 * `learning` stream. The loop never changes behavior directly — its output
 * is proposals plus an auditable run report, so learning stays reviewable,
 * correctable, and reversible (ADR 0025/0026).
 */

export const LEARNING_STREAM_ID = 'learning'

export function learningStreamId(): string {
  return LEARNING_STREAM_ID
}

export const LEARNING_EVENT_TYPES = [
  'learning.proposal.created',
  'learning.proposal.status_changed',
  'learning.loop.run',
  'learning.experiment.started',
  'learning.experiment.completed',
  'learning.experiment.failed',
  'learning.proposal.activated',
  'learning.proposal.activation-reverted',
] as const
export type LearningEventType = (typeof LEARNING_EVENT_TYPES)[number]

const StatusChangedPayloadSchema = z.object({
  proposalId: z.uuid(),
  from: z.enum([
    'draft',
    'testing',
    'review',
    'trial',
    'promoted',
    'rejected',
    'rolled-back',
  ]),
  to: z.enum([
    'draft',
    'testing',
    'review',
    'trial',
    'promoted',
    'rejected',
    'rolled-back',
  ]),
  reason: z.string().min(1).optional(),
})

const LoopRunPayloadSchema = z.object({
  ranAt: z.iso.datetime(),
  selectedTrajectories: z.number().int().nonnegative(),
  derivedTurns: z.number().int().nonnegative(),
  patternsFound: z.number().int().nonnegative(),
  proposalsCreated: z.array(z.uuid()),
  skippedDuplicates: z.number().int().nonnegative(),
  budget: z.object({
    maxTrajectories: z.number().int().positive(),
    maxProposalsPerRun: z.number().int().positive(),
  }),
})

const VerdictSchema = z.enum(['accept', 'reject', 'inconclusive'])

const RollbackPackageSchema = z.object({
  kind: z.enum([
    'no-op',
    'retract-skill',
    'remove-guardrail',
    'restore-planner-config',
  ]),
  description: z.string().min(1),
})

const ExperimentStartedPayloadSchema = z.object({
  experimentId: z.uuid(),
  proposalId: z.uuid(),
  datasetDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  evaluatorId: z.string().min(1),
  startedAt: z.iso.datetime(),
})

const ExperimentCompletedPayloadSchema = z.object({
  experimentId: z.uuid(),
  proposalId: z.uuid(),
  datasetDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  evaluatorId: z.string().min(1),
  verdict: VerdictSchema,
  metrics: z.record(z.string(), z.number()),
  notes: z.string().min(1).optional(),
  changesetDigest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .optional(),
  rollback: RollbackPackageSchema,
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
})

const ExperimentFailedPayloadSchema = z.object({
  experimentId: z.uuid(),
  proposalId: z.uuid(),
  evaluatorId: z.string().min(1),
  message: z.string().min(1),
  failedAt: z.iso.datetime(),
})

const ProposalActivatedPayloadSchema = z.object({
  proposalId: z.uuid(),
  /** The governed channel the change took effect through. */
  via: z.enum(['memory-claim']),
  claimId: z.uuid(),
  activatedAt: z.iso.datetime(),
})

const ActivationRevertedPayloadSchema = z.object({
  proposalId: z.uuid(),
  claimId: z.uuid(),
  reason: z.string().min(1).optional(),
  revertedAt: z.iso.datetime(),
})

const LEARNING_EVENT_PAYLOADS: Record<LearningEventType, z.ZodType<unknown>> = {
  'learning.proposal.created': z.object({
    proposal: ImprovementProposalSchema,
  }),
  'learning.proposal.status_changed': StatusChangedPayloadSchema,
  'learning.loop.run': LoopRunPayloadSchema,
  'learning.experiment.started': ExperimentStartedPayloadSchema,
  'learning.experiment.completed': ExperimentCompletedPayloadSchema,
  'learning.experiment.failed': ExperimentFailedPayloadSchema,
  'learning.proposal.activated': ProposalActivatedPayloadSchema,
  'learning.proposal.activation-reverted': ActivationRevertedPayloadSchema,
}

export class UnknownLearningEventTypeError extends Error {
  constructor(readonly eventType: string) {
    super(`Event type '${eventType}' is not a learning event`)
    this.name = 'UnknownLearningEventTypeError'
  }
}

export function registerLearningChronicleEvents(
  registry: ChronicleSchemaRegistry,
): void {
  for (const [eventType, payload] of Object.entries(LEARNING_EVENT_PAYLOADS)) {
    registry.register(eventType, { payload: payload as never })
  }
}

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

export interface LearningEventBuildOptions {
  readonly actor?: ChronicleActor | undefined
}

const LOOP_ACTOR: ChronicleActor = { type: 'system', id: 'bee-learning' }

export function learningProposalCreatedEvent(
  proposal: ImprovementProposal,
  options: LearningEventBuildOptions = {},
): NewChronicleEvent {
  return newChronicleEvent({
    eventType: 'learning.proposal.created',
    actor: options.actor ?? LOOP_ACTOR,
    payload: { proposal },
  })
}

export function learningProposalStatusChangedEvent(
  input: {
    readonly proposalId: string
    readonly from: ProposalStatus
    readonly to: ProposalStatus
    readonly reason?: string | undefined
  },
  options: LearningEventBuildOptions = {},
): NewChronicleEvent {
  return newChronicleEvent({
    eventType: 'learning.proposal.status_changed',
    actor: options.actor ?? LOOP_ACTOR,
    payload: StatusChangedPayloadSchema.parse({
      proposalId: input.proposalId,
      from: input.from,
      to: input.to,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    }),
  })
}

export interface LearningRunReport {
  readonly ranAt: string
  readonly selectedTrajectories: number
  readonly derivedTurns: number
  readonly patternsFound: number
  readonly proposalsCreated: readonly string[]
  readonly skippedDuplicates: number
  readonly budget: {
    readonly maxTrajectories: number
    readonly maxProposalsPerRun: number
  }
}

export function learningLoopRunEvent(
  report: LearningRunReport,
  options: LearningEventBuildOptions = {},
): NewChronicleEvent {
  return newChronicleEvent({
    eventType: 'learning.loop.run',
    actor: options.actor ?? LOOP_ACTOR,
    payload: LoopRunPayloadSchema.parse(report),
  })
}

export function learningExperimentStartedEvent(
  payload: z.infer<typeof ExperimentStartedPayloadSchema>,
  options: LearningEventBuildOptions = {},
): NewChronicleEvent {
  return newChronicleEvent({
    eventType: 'learning.experiment.started',
    actor: options.actor ?? LOOP_ACTOR,
    payload: ExperimentStartedPayloadSchema.parse(payload),
  })
}

export function learningExperimentCompletedEvent(
  payload: z.infer<typeof ExperimentCompletedPayloadSchema>,
  options: LearningEventBuildOptions = {},
): NewChronicleEvent {
  return newChronicleEvent({
    eventType: 'learning.experiment.completed',
    actor: options.actor ?? LOOP_ACTOR,
    payload: ExperimentCompletedPayloadSchema.parse(payload),
  })
}

export function learningExperimentFailedEvent(
  payload: z.infer<typeof ExperimentFailedPayloadSchema>,
  options: LearningEventBuildOptions = {},
): NewChronicleEvent {
  return newChronicleEvent({
    eventType: 'learning.experiment.failed',
    actor: options.actor ?? LOOP_ACTOR,
    payload: ExperimentFailedPayloadSchema.parse(payload),
  })
}

export function learningProposalActivatedEvent(
  payload: z.infer<typeof ProposalActivatedPayloadSchema>,
  options: LearningEventBuildOptions = {},
): NewChronicleEvent {
  return newChronicleEvent({
    eventType: 'learning.proposal.activated',
    actor: options.actor ?? LOOP_ACTOR,
    payload: ProposalActivatedPayloadSchema.parse(payload),
  })
}

export function learningActivationRevertedEvent(
  payload: z.infer<typeof ActivationRevertedPayloadSchema>,
  options: LearningEventBuildOptions = {},
): NewChronicleEvent {
  return newChronicleEvent({
    eventType: 'learning.proposal.activation-reverted',
    actor: options.actor ?? LOOP_ACTOR,
    payload: ActivationRevertedPayloadSchema.parse(payload),
  })
}
