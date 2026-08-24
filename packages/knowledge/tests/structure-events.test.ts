import { describe, expect, it } from 'vitest'
import { resolveEffectiveStructure, BundleSchema } from '@bee-agent/kernel'
import type { Bundle, EffectiveStructure } from '@bee-agent/kernel'
import {
  ChronicleSchemaRegistry,
  STRUCTURE_RESOLVED_EVENT_TYPE,
  STRUCTURE_STREAM_ID,
  StructureResolvedPayloadSchema,
  appendResolvedStructure,
  registerStructureChronicleEvents,
  structureResolvedEvent,
} from '../src/index.js'
import type { ChronicleEvent } from '../src/index.js'
import { MemoryChronicleStore } from '../src/testing.js'

function createRegistryStore(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerStructureChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

const baseBundle: Bundle = BundleSchema.parse({
  id: 'bee-core',
  version: '1.0.0',
  model: { id: 'openai', version: 'gpt-5.3' },
  prompt: { id: 'bee-system', version: '3' },
  contextPolicy: { id: 'default-context', version: '1' },
  memoryView: { id: 'personal', version: '2' },
  sandbox: { id: 'local-sandbox', version: '1' },
  evalPolicy: { id: 'default-eval', version: '1' },
})

async function resolveVariant(
  overrides: Partial<Bundle>,
): Promise<EffectiveStructure> {
  return resolveEffectiveStructure(
    BundleSchema.parse({ ...baseBundle, ...overrides }),
  )
}

async function collectStructureEvents(
  store: MemoryChronicleStore,
): Promise<ChronicleEvent[]> {
  const events: ChronicleEvent[] = []
  for await (const event of store.readStream(STRUCTURE_STREAM_ID)) {
    events.push(event)
  }
  return events
}

describe('structure lineage in Chronicle', () => {
  it('writes a resolved structure with its digest as structureVersion', async () => {
    const store = createRegistryStore()
    const structure = await resolveVariant({})

    const stored = await appendResolvedStructure(store, structure)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.sequence).toBe(1)
    expect(stored[0]?.streamId).toBe(STRUCTURE_STREAM_ID)
    expect(stored[0]?.eventType).toBe(STRUCTURE_RESOLVED_EVENT_TYPE)
    expect(stored[0]?.structureVersion).toBe(structure.digest)
    expect(stored[0]?.actor).toEqual({ type: 'system', id: 'host' })

    const payload = StructureResolvedPayloadSchema.parse(stored[0]?.payload)
    expect(payload.digest).toBe(structure.digest)
    expect(payload.structure).toEqual(structure)
    expect(await store.getLatestSequence(STRUCTURE_STREAM_ID)).toBe(1)
  })

  it('does not create a new version when the digest is unchanged', async () => {
    const store = createRegistryStore()
    const first = await resolveVariant({})
    const again = await resolveVariant({})

    await appendResolvedStructure(store, first)
    const deduped = await appendResolvedStructure(store, again)

    expect(deduped).toHaveLength(1)
    expect(deduped[0]?.payload).toMatchObject({ digest: first.digest })
    expect(await store.getLatestSequence(STRUCTURE_STREAM_ID)).toBe(1)
    expect(await collectStructureEvents(store)).toHaveLength(1)
  })

  it('appends a new version when the structure changes', async () => {
    const store = createRegistryStore()
    const before = await resolveVariant({})
    const after = await resolveVariant({
      model: { id: 'openai', version: 'gpt-5.4' },
    })

    await appendResolvedStructure(store, before)
    const stored = await appendResolvedStructure(store, after)

    expect(stored[0]?.sequence).toBe(2)
    const events = await collectStructureEvents(store)
    expect(events.map((event) => event.sequence)).toEqual([1, 2])
    const digests = events.map((event) =>
      StructureResolvedPayloadSchema.parse(event.payload),
    )
    expect(digests.map((payload) => payload.digest)).toEqual([
      before.digest,
      after.digest,
    ])
  })

  it('honors an explicit expectedSequence and lets conflicts surface', async () => {
    const store = createRegistryStore()
    const structure = await resolveVariant({})

    const stored = await appendResolvedStructure(store, structure, {
      expectedSequence: 1,
    })
    expect(stored[0]?.sequence).toBe(1)

    const other = await resolveVariant({
      permissions: ['fs:read'],
    })
    await expect(
      appendResolvedStructure(store, other, { expectedSequence: 1 }),
    ).rejects.toThrow(/expected next sequence 1/)
  })

  it('fails loud when the event type is not registered', async () => {
    const registry = new ChronicleSchemaRegistry()
    const store = new MemoryChronicleStore(registry)
    const structure = await resolveVariant({})

    expect(() => structureResolvedEvent(structure)).not.toThrow()
    await expect(
      store.append(STRUCTURE_STREAM_ID, [structureResolvedEvent(structure)], {
        expectedSequence: 1,
      }),
    ).rejects.toThrow(/Unknown Chronicle event type/)
  })
})
