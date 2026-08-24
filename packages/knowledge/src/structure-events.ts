import { z } from 'zod'
import { BEE_PROFILE_ID, EffectiveStructureSchema } from '@bee-agent/kernel'
import type { EffectiveStructure } from '@bee-agent/kernel'
import { newChronicleEvent } from './envelope.js'
import type { ChronicleEvent, NewChronicleEvent } from './envelope.js'
import type { ChronicleSchemaRegistry } from './registry.js'
import type { ChronicleStore } from './chronicle-store.js'

/** The single stream holding the resolved-structure lineage. */
export const STRUCTURE_STREAM_ID = 'structure'

export const STRUCTURE_RESOLVED_EVENT_TYPE = 'structure.resolved'

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

export interface AppendResolvedStructureOptions {
  /**
   * Skip the dedup check and append at this exact sequence. When omitted,
   * the helper reads the stream tail and appends after it.
   */
  readonly expectedSequence?: number | undefined
}

async function readLatest(
  store: ChronicleStore,
): Promise<ChronicleEvent | undefined> {
  const latestSequence = await store.getLatestSequence(STRUCTURE_STREAM_ID)
  if (latestSequence === 0) return undefined
  let last: ChronicleEvent | undefined
  for await (const event of store.readStream(
    STRUCTURE_STREAM_ID,
    latestSequence - 1,
  )) {
    last = event
  }
  return last
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
  const latest = await readLatest(store)
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
