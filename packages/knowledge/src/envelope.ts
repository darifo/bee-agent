import { randomUUID } from 'node:crypto'
import { z } from 'zod'

/**
 * The Chronicle event envelope (v1 refactor plan §5.2 P1-5, architecture
 * §8.2). Every durable fact in Bee Agent flows through this shape: streams
 * are keyed by `(streamId, sequence)`, causality links events across streams,
 * and dual-time fields separate when something happened (`eventTime`), when
 * Bee Agent learned it (`ingestTime`, store-assigned), and when it was true
 * in the world (`validTime`).
 */

export const ChronicleActorSchema = z.object({
  type: z.enum(['user', 'agent', 'system', 'tool']),
  id: z.string().min(1),
})
export type ChronicleActor = z.infer<typeof ChronicleActorSchema>

export const EventClassificationSchema = z.enum([
  'public',
  'internal',
  'confidential',
  'secret',
])
export type EventClassification = z.infer<typeof EventClassificationSchema>

export const ValidTimeSchema = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime().optional(),
})
export type ValidTime = z.infer<typeof ValidTimeSchema>

/** Scope ids linking an event into goal/plan/task/episode/thread/turn/step. */
export const ChronicleScopeSchema = z.object({
  goalId: z.string().min(1).optional(),
  planId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  episodeId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  stepId: z.string().min(1).optional(),
})

/**
 * An event as handed to {@link ChronicleStore.append}: the producer fills
 * everything except `sequence`, `streamId`, and `ingestTime`, which the
 * store assigns atomically.
 */
export const NewChronicleEventSchema = z
  .object({
    eventId: z.uuid(),
    eventType: z.string().min(1),
    schemaVersion: z.number().int().positive(),
    eventTime: z.iso.datetime(),
    validTime: ValidTimeSchema.optional(),
    ...ChronicleScopeSchema.shape,
    actor: ChronicleActorSchema,
    causationId: z.uuid().optional(),
    correlationId: z.uuid(),
    parentIds: z.array(z.uuid()).optional(),
    worldVersion: z.string().min(1).optional(),
    structureVersion: z.string().min(1).optional(),
    policyVersion: z.string().min(1).optional(),
    contextManifestId: z.string().min(1).optional(),
    classification: EventClassificationSchema,
    retentionClass: z.string().min(1),
    payload: z.unknown(),
  })
  .strict()

/** A stored event: the envelope plus store-assigned positioning fields. */
export const ChronicleEventSchema = NewChronicleEventSchema.extend({
  streamId: z.string().min(1),
  sequence: z.number().int().positive(),
  ingestTime: z.iso.datetime(),
})

export type NewChronicleEvent = z.infer<typeof NewChronicleEventSchema>
export type ChronicleEvent = z.infer<typeof ChronicleEventSchema>

/** Producer-facing input: everything required minus the noisy defaults. */
export interface NewChronicleEventInput<T = unknown>
  extends Omit<
    NewChronicleEvent,
    | 'eventId'
    | 'schemaVersion'
    | 'eventTime'
    | 'correlationId'
    | 'classification'
    | 'retentionClass'
    | 'payload'
  > {
  readonly payload: T
  readonly eventId?: string | undefined
  readonly schemaVersion?: number | undefined
  readonly eventTime?: string | undefined
  readonly correlationId?: string | undefined
  readonly classification?: EventClassification | undefined
  readonly retentionClass?: string | undefined
}

/**
 * Builds a valid {@link NewChronicleEvent}: `eventId` defaults to a fresh
 * uuid, `correlationId` defaults to the event id (a producer that starts a
 * new flow passes nothing; continuations pass the originating id),
 * `eventTime` defaults to now, `classification` to `internal`, and
 * `retentionClass` to `default`.
 */
export function newChronicleEvent<T = unknown>(
  input: NewChronicleEventInput<T>,
): NewChronicleEvent {
  const eventId = input.eventId ?? randomUUID()
  return {
    ...input,
    eventId,
    payload: input.payload,
    schemaVersion: input.schemaVersion ?? 1,
    eventTime: input.eventTime ?? new Date().toISOString(),
    correlationId: input.correlationId ?? eventId,
    classification: input.classification ?? 'internal',
    retentionClass: input.retentionClass ?? 'default',
  }
}
