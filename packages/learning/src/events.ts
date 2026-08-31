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

const LEARNING_EVENT_PAYLOADS: Record<LearningEventType, z.ZodType<unknown>> = {
  'learning.proposal.created': z.object({
    proposal: ImprovementProposalSchema,
  }),
  'learning.proposal.status_changed': StatusChangedPayloadSchema,
  'learning.loop.run': LoopRunPayloadSchema,
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
