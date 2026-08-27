import { describe, expect, it } from 'vitest'
import { BundleSchema, resolveEffectiveStructure } from '@bee-agent/kernel'
import type { Bundle, EffectiveStructure } from '@bee-agent/kernel'
import {
  ChronicleSchemaRegistry,
  StructureGraphStore,
  appendResolvedStructure,
  appendStructureLifecycleEvent,
  registerStructureChronicleEvents,
} from '../src/index.ts'
import { MemoryChronicleStore } from '../src/testing.ts'
import type { KernelLifecycleEvent } from '@bee-agent/kernel'

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

function lifecycle(
  type: KernelLifecycleEvent['type'],
  generationId: string,
  structureVersion: string,
): KernelLifecycleEvent {
  return {
    type,
    generationId,
    structureVersion,
  } as KernelLifecycleEvent
}

describe('StructureGraphStore', () => {
  it('replays the lineage with supersession and full phase history', async () => {
    const store = createRegistryStore()
    const first = await resolveVariant({})
    const second = await resolveVariant({
      prompt: { id: 'bee-system', version: '4' },
    })
    const failed = await resolveVariant({
      model: { id: 'other', version: 'x' },
    })
    const firstGeneration = crypto.randomUUID()
    const failedGeneration = crypto.randomUUID()
    const secondGeneration = crypto.randomUUID()

    await appendResolvedStructure(store, first)
    await appendStructureLifecycleEvent(
      store,
      lifecycle('generation.prepared', firstGeneration, first.digest),
    )
    await appendStructureLifecycleEvent(
      store,
      lifecycle('generation.activated', firstGeneration, first.digest),
    )
    await appendResolvedStructure(store, failed)
    await appendStructureLifecycleEvent(store, {
      type: 'generation.failed',
      generationId: failedGeneration,
      structureVersion: failed.digest,
      error: new Error('plugin missing'),
    } as KernelLifecycleEvent)
    await appendResolvedStructure(store, second)
    await appendStructureLifecycleEvent(
      store,
      lifecycle('generation.activated', secondGeneration, second.digest),
    )
    await appendStructureLifecycleEvent(
      store,
      lifecycle('generation.draining', firstGeneration, first.digest),
    )

    const graph = new StructureGraphStore(store)
    await graph.rebuild()
    const snapshot = graph.snapshot()

    expect(snapshot.active).toBe(second.digest)
    expect(snapshot.entries.map((entry) => entry.digest)).toEqual([
      first.digest,
      failed.digest,
      second.digest,
    ])
    expect(snapshot.entries[0]!.supersededBy).toBe(failed.digest)
    expect(snapshot.entries[2]!.supersededBy).toBeUndefined()

    const firstEntry = graph.version(first.digest)!
    expect(firstEntry.phases.map((phase) => phase.phase)).toEqual([
      'resolved',
      'prepared',
      'activated',
      'draining',
    ])
    const failedEntry = graph.version(failed.digest)!
    expect(failedEntry.phases.at(-1)).toMatchObject({
      phase: 'activation_failed',
      error: { name: 'Error', message: 'plugin missing' },
    })

    // The active entry still carries its structure for inspection.
    expect(graph.version(second.digest)!.structure.digest).toBe(second.digest)
    await store.close()
  })

  it('ignores duplicate resolutions of the same digest', async () => {
    const store = createRegistryStore()
    const structure = await resolveVariant({})
    const generation = crypto.randomUUID()
    await appendResolvedStructure(store, structure)
    await appendResolvedStructure(store, structure)
    await appendStructureLifecycleEvent(
      store,
      lifecycle('generation.activated', generation, structure.digest),
    )

    const graph = new StructureGraphStore(store)
    await graph.rebuild()
    expect(graph.snapshot().entries).toHaveLength(1)
    expect(graph.snapshot().active).toBe(structure.digest)
    await store.close()
  })
})
