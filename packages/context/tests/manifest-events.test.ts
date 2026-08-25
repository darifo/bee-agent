import { describe, expect, it } from 'vitest'
import { ChronicleSchemaRegistry } from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import {
  CONTEXT_MANIFEST_EVENT_TYPE,
  ContextManifestPayloadSchema,
  appendContextManifest,
  buildContextManifest,
  registerContextManifestChronicleEvents,
} from '../src/index.ts'
import type { ContextManifest } from '../src/index.ts'

function createStore(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerContextManifestChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

function manifestFixture(): ContextManifest {
  return buildContextManifest({
    id: '0b6c6a68-8c5f-4d8f-9b52-1f2b1a2c3d4e',
    promptVersion: 'bee-system@3',
    structureVersion:
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    tokenBudget: 32000,
    sections: [
      {
        kind: 'instruction',
        sourceIds: ['prompt/bee-system@3'],
        rendererVersion: 'identity@1',
        priority: 0,
        content: 'You are Bee.',
      },
    ],
  })
}

describe('context.manifest persistence', () => {
  it('records a manifest event that round-trips its payload', async () => {
    const store = createStore()
    const manifest = manifestFixture()
    const scope = {
      threadId: '0b6c6a68-8c5f-4d8f-9b52-1f2b1a2c3d4e',
      turnId: '1c7d7b79-9d6f-5e9f-ac63-2f3c2b3d4e5f',
      structureVersion: manifest.structureVersion,
    }

    const streamId = 'context:0b6c6a68-8c5f-4d8f-9b52-1f2b1a2c3d4e'
    const stored = await appendContextManifest(store, streamId, manifest, scope)

    expect(stored).toHaveLength(1)
    expect(stored[0]?.eventType).toBe(CONTEXT_MANIFEST_EVENT_TYPE)
    expect(stored[0]?.contextManifestId).toBe(manifest.id)
    expect(stored[0]?.threadId).toBe(scope.threadId)
    expect(stored[0]?.turnId).toBe(scope.turnId)
    const payload = ContextManifestPayloadSchema.parse(stored[0]?.payload)
    expect(payload.manifest).toEqual(manifest)
  })

  it('fails loud when the event type is not registered', async () => {
    const registry = new ChronicleSchemaRegistry()
    const store = new MemoryChronicleStore(registry)
    const manifest = manifestFixture()
    const scope = {
      threadId: '0b6c6a68-8c5f-4d8f-9b52-1f2b1a2c3d4e',
      turnId: '1c7d7b79-9d6f-5e9f-ac63-2f3c2b3d4e5f',
      structureVersion: manifest.structureVersion,
    }
    await expect(
      appendContextManifest(store, 'context:x', manifest, scope),
    ).rejects.toThrow(/Unknown Chronicle event type/)
  })
})
