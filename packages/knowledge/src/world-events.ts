import { z } from 'zod'
import { newChronicleEvent } from './envelope.ts'
import type { ChronicleActor, NewChronicleEvent } from './envelope.ts'
import type { ChronicleSchemaRegistry } from './registry.ts'
import {
  WorldEntitySchema,
  WorldRelationSchema,
  WorldVersionSchema,
} from './world-schema.ts'
import type {
  WorldEntity,
  WorldRelation,
  WorldVersion,
} from './world-schema.ts'

/**
 * World Chronicle events (v1 refactor plan §5.5 WF4-D): every world-model
 * mutation is a durable fact on the serialized `world` stream — recorded
 * entities, projected relations (each with provenance), and version bumps
 * carrying a digest of the full projected state, so replay can verify that
 * rebuilds are exact.
 */

/** The single serialized stream holding the world projection log. */
export const WORLD_STREAM_ID = 'world'

export function worldStreamId(): string {
  return WORLD_STREAM_ID
}

export const WORLD_EVENT_TYPES = [
  'world.entity.recorded',
  'world.relation.projected',
  'world.version.bumped',
] as const
export type WorldEventType = (typeof WORLD_EVENT_TYPES)[number]

const WORLD_EVENT_PAYLOADS: Record<WorldEventType, z.ZodType<unknown>> = {
  'world.entity.recorded': z.object({ entity: WorldEntitySchema }),
  'world.relation.projected': z.object({ relation: WorldRelationSchema }),
  'world.version.bumped': WorldVersionSchema,
}

/** Registers every world event type on a Chronicle registry. */
export function registerWorldChronicleEvents(
  registry: ChronicleSchemaRegistry,
): void {
  for (const [eventType, payload] of Object.entries(WORLD_EVENT_PAYLOADS)) {
    registry.register(eventType, { payload: payload as never })
  }
}

export class UnknownWorldEventTypeError extends Error {
  constructor(readonly eventType: string) {
    super(`Event type '${eventType}' is not a world event`)
    this.name = 'UnknownWorldEventTypeError'
  }
}

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

export interface WorldEventBuildOptions {
  readonly actor?: ChronicleActor | undefined
}

const WORLD_ACTOR: ChronicleActor = { type: 'agent', id: 'bee' }

function worldEvent(
  eventType: WorldEventType,
  scope: {
    threadId?: string | undefined
    turnId?: string | undefined
  },
  payload: unknown,
  options: WorldEventBuildOptions,
): NewChronicleEvent {
  return newChronicleEvent({
    eventType,
    actor: options.actor ?? WORLD_ACTOR,
    ...(scope.threadId !== undefined ? { threadId: scope.threadId } : {}),
    ...(scope.turnId !== undefined ? { turnId: scope.turnId } : {}),
    payload,
  })
}

export function worldEntityRecordedEvent(
  entity: WorldEntity,
  options: WorldEventBuildOptions = {},
): NewChronicleEvent {
  return worldEvent('world.entity.recorded', {}, { entity }, options)
}

export function worldRelationProjectedEvent(
  relation: WorldRelation,
  options: WorldEventBuildOptions = {},
): NewChronicleEvent {
  return worldEvent(
    'world.relation.projected',
    {
      threadId: relation.provenance.threadId,
      turnId: relation.provenance.turnId,
    },
    { relation },
    options,
  )
}

export function worldVersionBumpedEvent(
  version: WorldVersion,
  options: WorldEventBuildOptions = {},
): NewChronicleEvent {
  return worldEvent(
    'world.version.bumped',
    {},
    WorldVersionSchema.parse(version),
    options,
  )
}
