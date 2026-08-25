import { z } from 'zod'
import { BEE_PROFILE_ID, EffectiveStructureSchema } from '@bee-agent/kernel'
import type { EffectiveStructure } from '@bee-agent/kernel'
import type { KernelLifecycleEvent } from '@bee-agent/kernel'
import { newChronicleEvent } from './envelope.ts'
import type { ChronicleEvent, NewChronicleEvent } from './envelope.ts'
import type { ChronicleSchemaRegistry } from './registry.ts'
import type { ChronicleStore } from './chronicle-store.ts'

/** The single stream holding the resolved-structure lineage. */
export const STRUCTURE_STREAM_ID = 'structure'

export const STRUCTURE_RESOLVED_EVENT_TYPE = 'structure.resolved'
export const STRUCTURE_PREPARED_EVENT_TYPE = 'structure.prepared'
export const STRUCTURE_ACTIVATED_EVENT_TYPE = 'structure.activated'
export const STRUCTURE_ACTIVATION_FAILED_EVENT_TYPE =
  'structure.activation_failed'
export const STRUCTURE_DRAINING_EVENT_TYPE = 'structure.draining'
export const STRUCTURE_DISPOSED_EVENT_TYPE = 'structure.disposed'
export const STRUCTURE_RESTART_REQUIRED_EVENT_TYPE =
  'structure.restart_required'

const StructureLifecycleBaseSchema = z.object({
  generationId: z.uuid(),
  digest: EffectiveStructureSchema.shape.digest,
})

export const StructureLifecyclePayloadSchema =
  StructureLifecycleBaseSchema.extend({
    phase: z.enum(['prepared', 'activated', 'draining', 'disposed']),
  })
export type StructureLifecyclePayload = z.infer<
  typeof StructureLifecyclePayloadSchema
>

export const StructureActivationFailedPayloadSchema =
  StructureLifecycleBaseSchema.extend({
    phase: z.literal('activation_failed'),
    error: z.object({ name: z.string().min(1), message: z.string() }),
  })
export type StructureActivationFailedPayload = z.infer<
  typeof StructureActivationFailedPayloadSchema
>

export const StructureRestartRequiredPayloadSchema =
  StructureLifecycleBaseSchema.extend({
    phase: z.literal('restart_required'),
    pluginIds: z.array(z.string().min(1)).min(1),
  })
export type StructureRestartRequiredPayload = z.infer<
  typeof StructureRestartRequiredPayloadSchema
>

/**
 * Payload of a `structure.resolved` event (v1 refactor plan §5.2 P1-3,
 * architecture §14.4): the immutable effective structure produced by
 * resolving a bundle chain, its digest, and the bundle chain itself.
 */
export const StructureResolvedPayloadSchema = z.object({
  profileId: z.literal(BEE_PROFILE_ID),
  digest: EffectiveStructureSchema.shape.digest,
  bundles: EffectiveStructureSchema.shape.bundles,
  structure: EffectiveStructureSchema,
})
export type StructureResolvedPayload = z.infer<
  typeof StructureResolvedPayloadSchema
>

/** Registers the structure lineage event types on a Chronicle registry. */
export function registerStructureChronicleEvents(
  registry: ChronicleSchemaRegistry,
): void {
  registry.register(STRUCTURE_RESOLVED_EVENT_TYPE, {
    payload: StructureResolvedPayloadSchema,
  })
  for (const eventType of [
    STRUCTURE_PREPARED_EVENT_TYPE,
    STRUCTURE_ACTIVATED_EVENT_TYPE,
    STRUCTURE_DRAINING_EVENT_TYPE,
    STRUCTURE_DISPOSED_EVENT_TYPE,
  ]) {
    registry.register(eventType, { payload: StructureLifecyclePayloadSchema })
  }
  registry.register(STRUCTURE_ACTIVATION_FAILED_EVENT_TYPE, {
    payload: StructureActivationFailedPayloadSchema,
  })
  registry.register(STRUCTURE_RESTART_REQUIRED_EVENT_TYPE, {
    payload: StructureRestartRequiredPayloadSchema,
  })
}

/**
 * Builds the `structure.resolved` event for an already-resolved structure.
 * The envelope's `structureVersion` carries the digest, so every later
 * event can be tied back to the structure it ran under.
 */
export function structureResolvedEvent(
  structure: EffectiveStructure,
): NewChronicleEvent {
  const payload = StructureResolvedPayloadSchema.parse({
    profileId: structure.profileId,
    digest: structure.digest,
    bundles: structure.bundles,
    structure,
  })
  return newChronicleEvent({
    eventType: STRUCTURE_RESOLVED_EVENT_TYPE,
    actor: { type: 'system', id: 'host' },
    structureVersion: structure.digest,
    payload,
  })
}

function errorPayload(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message }
  }
  return { name: 'Error', message: String(error) }
}

/** Converts an in-memory Kernel lifecycle transition into a durable fact. */
export function structureLifecycleEvent(
  event: KernelLifecycleEvent,
): NewChronicleEvent {
  const base = {
    generationId: event.generationId,
    digest: event.structureVersion,
  }
  switch (event.type) {
    case 'generation.prepared':
      return newChronicleEvent({
        eventType: STRUCTURE_PREPARED_EVENT_TYPE,
        actor: { type: 'system', id: 'kernel' },
        structureVersion: event.structureVersion,
        payload: { ...base, phase: 'prepared' },
      })
    case 'generation.activated':
      return newChronicleEvent({
        eventType: STRUCTURE_ACTIVATED_EVENT_TYPE,
        actor: { type: 'system', id: 'kernel' },
        structureVersion: event.structureVersion,
        payload: { ...base, phase: 'activated' },
      })
    case 'generation.failed':
      return newChronicleEvent({
        eventType: STRUCTURE_ACTIVATION_FAILED_EVENT_TYPE,
        actor: { type: 'system', id: 'kernel' },
        structureVersion: event.structureVersion,
        payload: {
          ...base,
          phase: 'activation_failed',
          error: errorPayload(event.error),
        },
      })
    case 'generation.draining':
      return newChronicleEvent({
        eventType: STRUCTURE_DRAINING_EVENT_TYPE,
        actor: { type: 'system', id: 'kernel' },
        structureVersion: event.structureVersion,
        payload: { ...base, phase: 'draining' },
      })
    case 'generation.disposed':
      return newChronicleEvent({
        eventType: STRUCTURE_DISPOSED_EVENT_TYPE,
        actor: { type: 'system', id: 'kernel' },
        structureVersion: event.structureVersion,
        payload: { ...base, phase: 'disposed' },
      })
    case 'generation.restart_required':
      return newChronicleEvent({
        eventType: STRUCTURE_RESTART_REQUIRED_EVENT_TYPE,
        actor: { type: 'system', id: 'kernel' },
        structureVersion: event.structureVersion,
        payload: {
          ...base,
          phase: 'restart_required',
          pluginIds: [...event.pluginIds],
        },
      })
  }
}

/** Appends one lifecycle event at the current tail of the structure stream. */
export async function appendStructureLifecycleEvent(
  store: ChronicleStore,
  event: KernelLifecycleEvent,
): Promise<readonly ChronicleEvent[]> {
  const expectedSequence =
    (await store.getLatestSequence(STRUCTURE_STREAM_ID)) + 1
  return store.append(STRUCTURE_STREAM_ID, [structureLifecycleEvent(event)], {
    expectedSequence,
  })
}

export interface AppendResolvedStructureOptions {
  /**
   * Skip the dedup check and append at this exact sequence. When omitted,
   * the helper reads the stream tail and appends after it.
   */
  readonly expectedSequence?: number | undefined
}

async function readLatestResolved(
  store: ChronicleStore,
): Promise<ChronicleEvent | undefined> {
  let latest: ChronicleEvent | undefined
  for await (const event of store.readStream(STRUCTURE_STREAM_ID)) {
    if (event.eventType === STRUCTURE_RESOLVED_EVENT_TYPE) latest = event
  }
  return latest
}

/**
 * Writes a resolved structure to the Chronicle structure stream. Startup
 * resolves the same unchanged bundle every time, so when the stream's last
 * event already records this digest the stored event is returned and
 * nothing is appended: only actual structure changes create versions.
 * Sequence conflicts from concurrent writers are rethrown; retrying the
 * call lands in the dedup path.
 */
export async function appendResolvedStructure(
  store: ChronicleStore,
  structure: EffectiveStructure,
  options: AppendResolvedStructureOptions = {},
): Promise<readonly ChronicleEvent[]> {
  if (options.expectedSequence !== undefined) {
    return store.append(
      STRUCTURE_STREAM_ID,
      [structureResolvedEvent(structure)],
      { expectedSequence: options.expectedSequence },
    )
  }
  const latest = await readLatestResolved(store)
  if (
    latest !== undefined &&
    latest.eventType === STRUCTURE_RESOLVED_EVENT_TYPE
  ) {
    const payload = StructureResolvedPayloadSchema.safeParse(latest.payload)
    if (payload.success && payload.data.digest === structure.digest) {
      return [latest]
    }
  }
  const expectedSequence = await store.getLatestSequence(STRUCTURE_STREAM_ID)
  return store.append(
    STRUCTURE_STREAM_ID,
    [structureResolvedEvent(structure)],
    {
      expectedSequence: expectedSequence + 1,
    },
  )
}

/**
 * Rebuilds the last successfully activated EffectiveStructure. A newer
 * resolved-but-failed candidate is intentionally ignored.
 */
export async function readActiveStructure(
  store: ChronicleStore,
): Promise<EffectiveStructure | undefined> {
  const resolved = new Map<string, EffectiveStructure>()
  let activeDigest: string | undefined
  for await (const event of store.readStream(STRUCTURE_STREAM_ID)) {
    if (event.eventType === STRUCTURE_RESOLVED_EVENT_TYPE) {
      const payload = StructureResolvedPayloadSchema.parse(event.payload)
      resolved.set(payload.digest, payload.structure)
    } else if (event.eventType === STRUCTURE_ACTIVATED_EVENT_TYPE) {
      const payload = StructureLifecyclePayloadSchema.parse(event.payload)
      activeDigest = payload.digest
    }
  }
  if (activeDigest === undefined) return undefined
  const structure = resolved.get(activeDigest)
  if (structure === undefined) {
    throw new Error(
      `Activated structure '${activeDigest}' has no structure.resolved event`,
    )
  }
  return structure
}
