import { z } from 'zod'
import { newChronicleEvent } from '@bee-agent/knowledge'
import type { ChronicleActor, NewChronicleEvent } from '@bee-agent/knowledge'
import type { ChronicleSchemaRegistry } from '@bee-agent/knowledge'

/**
 * Durable user grants (ADR 0023 user-grant layer): an approval the user
 * chose to remember becomes a fact on one serialized `grants` stream, so
 * the decision survives restarts. A later revoke supersedes it. Grants
 * relax `ask` to `allow` — they can never override a `deny`.
 */

export const GRANTS_STREAM_ID = 'grants'

export function grantsStreamId(): string {
  return GRANTS_STREAM_ID
}

export const GRANT_EVENT_TYPES = ['grant.recorded', 'grant.revoked'] as const
export type GrantEventType = (typeof GRANT_EVENT_TYPES)[number]

const GrantBaseSchema = z.object({
  capability: z.string().min(1),
  reason: z.string().min(1).optional(),
  by: z.string().min(1),
  at: z.iso.datetime(),
})

const GRANT_EVENT_PAYLOADS: Record<GrantEventType, z.ZodType<unknown>> = {
  'grant.recorded': GrantBaseSchema,
  'grant.revoked': GrantBaseSchema,
}

export class UnknownGrantEventTypeError extends Error {
  constructor(readonly eventType: string) {
    super(`Event type '${eventType}' is not a grant event`)
    this.name = 'UnknownGrantEventTypeError'
  }
}

export function registerGrantChronicleEvents(
  registry: ChronicleSchemaRegistry,
): void {
  for (const [eventType, payload] of Object.entries(GRANT_EVENT_PAYLOADS)) {
    registry.register(eventType, { payload: payload as never })
  }
}

const GRANT_ACTOR: ChronicleActor = { type: 'user', id: 'host' }

export interface GrantEventBuildOptions {
  readonly actor?: ChronicleActor | undefined
}

export function grantRecordedEvent(
  input: {
    readonly capability: string
    readonly reason?: string | undefined
    readonly by?: string | undefined
  },
  options: GrantEventBuildOptions = {},
): NewChronicleEvent {
  const at = new Date().toISOString()
  return newChronicleEvent({
    eventType: 'grant.recorded',
    actor: options.actor ?? GRANT_ACTOR,
    payload: GrantBaseSchema.parse({
      capability: input.capability,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      by: input.by ?? 'user',
      at,
    }),
  })
}

export function grantRevokedEvent(
  input: {
    readonly capability: string
    readonly reason?: string | undefined
    readonly by?: string | undefined
  },
  options: GrantEventBuildOptions = {},
): NewChronicleEvent {
  const at = new Date().toISOString()
  return newChronicleEvent({
    eventType: 'grant.revoked',
    actor: options.actor ?? GRANT_ACTOR,
    payload: GrantBaseSchema.parse({
      capability: input.capability,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      by: input.by ?? 'user',
      at,
    }),
  })
}
