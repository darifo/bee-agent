import { z } from 'zod'
import { newChronicleEvent } from './envelope.ts'
import type { ChronicleActor, NewChronicleEvent } from './envelope.ts'
import type { ChronicleSchemaRegistry } from './registry.ts'
import {
  MemoryClaimSchema,
  MemoryObservationSchema,
  type MemoryClaim,
  type MemoryConsolidationReport,
  type MemoryHealth,
  type MemoryObservation,
} from './memory.ts'

/**
 * Memory Chronicle events (v1 refactor plan §5.5 WF4-A): memory mutations are
 * durable facts, so recording, superseding, and forgetting a claim all append
 * to one serialized `memory` stream. Total order keeps conflict resolution
 * deterministic on replay; the thread/turn/item scope on each envelope links
 * the memory stream back to the conversation that produced it.
 */

/** The single serialized stream holding every memory mutation. */
export const MEMORY_STREAM_ID = 'memory'

export function memoryStreamId(): string {
  return MEMORY_STREAM_ID
}

export const MEMORY_EVENT_TYPES = [
  'memory.claim.recorded',
  'memory.claim.superseded',
  'memory.claim.retracted',
  'memory.observation.recorded',
  'memory.consolidation.completed',
  'memory.health.changed',
] as const
export type MemoryEventType = (typeof MEMORY_EVENT_TYPES)[number]

const MemoryConsolidationReportPayloadSchema = z.object({
  considered: z.number().int().nonnegative(),
  merged: z.array(
    z.object({
      kept: z.uuid(),
      superseded: z.array(z.uuid()),
    }),
  ),
  at: z.iso.datetime(),
})

const MemoryHealthChangedPayloadSchema = z.object({
  from: z.enum(['healthy', 'degraded', 'unavailable']),
  to: z.enum(['healthy', 'degraded', 'unavailable']),
  detail: z.string().min(1).optional(),
})

const MEMORY_EVENT_PAYLOADS: Record<MemoryEventType, z.ZodType<unknown>> = {
  'memory.claim.recorded': z.object({ claim: MemoryClaimSchema }),
  'memory.claim.superseded': z.object({
    claimId: z.uuid(),
    supersededBy: z.uuid(),
    reason: z.string().min(1).optional(),
  }),
  'memory.claim.retracted': z.object({
    claimId: z.uuid(),
    reason: z.string().min(1).optional(),
  }),
  'memory.observation.recorded': z.object({
    observation: MemoryObservationSchema,
  }),
  'memory.consolidation.completed': MemoryConsolidationReportPayloadSchema,
  'memory.health.changed': MemoryHealthChangedPayloadSchema,
}

/** Registers every memory event type on a Chronicle registry. */
export function registerMemoryChronicleEvents(
  registry: ChronicleSchemaRegistry,
): void {
  for (const [eventType, payload] of Object.entries(MEMORY_EVENT_PAYLOADS)) {
    registry.register(eventType, { payload: payload as never })
  }
}

export class UnknownMemoryEventTypeError extends Error {
  constructor(readonly eventType: string) {
    super(`Event type '${eventType}' is not a memory event`)
    this.name = 'UnknownMemoryEventTypeError'
  }
}

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

export interface MemoryEventBuildOptions {
  readonly actor?: ChronicleActor | undefined
}

const MEMORY_ACTOR: ChronicleActor = { type: 'agent', id: 'bee' }

function memoryEvent(
  eventType: MemoryEventType,
  scope: { threadId?: string | undefined; turnId?: string | undefined },
  payload: unknown,
  options: MemoryEventBuildOptions,
): NewChronicleEvent {
  return newChronicleEvent({
    eventType,
    actor: options.actor ?? MEMORY_ACTOR,
    ...(scope.threadId !== undefined ? { threadId: scope.threadId } : {}),
    ...(scope.turnId !== undefined ? { turnId: scope.turnId } : {}),
    payload,
  })
}

export function memoryClaimRecordedEvent(
  claim: MemoryClaim,
  options: MemoryEventBuildOptions = {},
): NewChronicleEvent {
  return memoryEvent(
    'memory.claim.recorded',
    {
      threadId: claim.provenance.threadId,
      turnId: claim.provenance.turnId,
    },
    { claim },
    options,
  )
}

export function memoryClaimSupersededEvent(
  input: {
    readonly claimId: string
    readonly supersededBy: string
    readonly reason?: string | undefined
  },
  options: MemoryEventBuildOptions = {},
): NewChronicleEvent {
  return memoryEvent(
    'memory.claim.superseded',
    {},
    {
      claimId: input.claimId,
      supersededBy: input.supersededBy,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    },
    options,
  )
}

export function memoryClaimRetractedEvent(
  input: { readonly claimId: string; readonly reason?: string | undefined },
  options: MemoryEventBuildOptions = {},
): NewChronicleEvent {
  return memoryEvent(
    'memory.claim.retracted',
    {},
    {
      claimId: input.claimId,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    },
    options,
  )
}

export function memoryObservationRecordedEvent(
  observation: MemoryObservation,
  options: MemoryEventBuildOptions = {},
): NewChronicleEvent {
  return memoryEvent(
    'memory.observation.recorded',
    {
      threadId: observation.provenance.threadId,
      turnId: observation.provenance.turnId,
    },
    { observation },
    options,
  )
}

export function memoryConsolidationCompletedEvent(
  report: MemoryConsolidationReport,
  options: MemoryEventBuildOptions = {},
): NewChronicleEvent {
  return memoryEvent(
    'memory.consolidation.completed',
    {},
    MemoryConsolidationReportPayloadSchema.parse(report),
    options,
  )
}

/**
 * Records an explicit provider health transition (WF4-C): a remote memory
 * going degraded or unavailable is a durable, auditable fact — never a
 * silent switch to empty memory.
 */
export function memoryHealthChangedEvent(
  transition: {
    readonly from: MemoryHealth['status']
    readonly to: MemoryHealth['status']
    readonly detail?: string | undefined
  },
  options: MemoryEventBuildOptions = {},
): NewChronicleEvent {
  return memoryEvent(
    'memory.health.changed',
    {},
    MemoryHealthChangedPayloadSchema.parse({
      from: transition.from,
      to: transition.to,
      ...(transition.detail !== undefined ? { detail: transition.detail } : {}),
    }),
    options,
  )
}
