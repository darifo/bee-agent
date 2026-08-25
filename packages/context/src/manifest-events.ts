import { z } from 'zod'
import { newChronicleEvent } from '@bee-agent/knowledge'
import type {
  ChronicleEvent,
  ChronicleSchemaRegistry,
  ChronicleStore,
  NewChronicleEvent,
} from '@bee-agent/knowledge'
import { ContextManifestSchema } from './context-manifest.ts'
import type { ContextManifest } from './context-manifest.ts'

/**
 * Persists ContextManifests into Chronicle (architecture §10.3): each model
 * call records its manifest as a `context.manifest` event, keyed to the
 * thread and turn that produced it, so historical calls are auditable and
 * rebuildable without keeping the full prompt.
 */

export const CONTEXT_MANIFEST_EVENT_TYPE = 'context.manifest'

export const ContextManifestPayloadSchema = z.object({
  manifest: ContextManifestSchema,
})

export function registerContextManifestChronicleEvents(
  registry: ChronicleSchemaRegistry,
): void {
  registry.register(CONTEXT_MANIFEST_EVENT_TYPE, {
    payload: ContextManifestPayloadSchema,
  })
}

export interface ContextManifestScope {
  readonly threadId: string
  readonly turnId: string
  readonly structureVersion: string
}

export function contextManifestEvent(
  manifest: ContextManifest,
  scope: ContextManifestScope,
): NewChronicleEvent {
  return newChronicleEvent({
    eventType: CONTEXT_MANIFEST_EVENT_TYPE,
    actor: { type: 'system', id: 'host' },
    threadId: scope.threadId,
    turnId: scope.turnId,
    structureVersion: scope.structureVersion,
    contextManifestId: manifest.id,
    payload: ContextManifestPayloadSchema.parse({ manifest }),
  })
}

/**
 * Appends a manifest to the given stream, after whatever is already stored.
 * Callers own the expected-sequence discipline for concurrent writers.
 */
export async function appendContextManifest(
  store: ChronicleStore,
  streamId: string,
  manifest: ContextManifest,
  scope: ContextManifestScope,
): Promise<readonly ChronicleEvent[]> {
  const expectedSequence = (await store.getLatestSequence(streamId)) + 1
  return store.append(streamId, [contextManifestEvent(manifest, scope)], {
    expectedSequence,
  })
}
