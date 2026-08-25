import { describe, expect, it } from 'vitest'
import { BundleSchema, resolveEffectiveStructure } from '@bee-agent/kernel'
import type { EffectiveStructure, RuntimePlugin } from '@bee-agent/kernel'
import {
  ChronicleSchemaRegistry,
  STRUCTURE_ACTIVATED_EVENT_TYPE,
  STRUCTURE_ACTIVATION_FAILED_EVENT_TYPE,
  STRUCTURE_RESOLVED_EVENT_TYPE,
  STRUCTURE_RESTART_REQUIRED_EVENT_TYPE,
  STRUCTURE_STREAM_ID,
  registerStructureChronicleEvents,
} from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import { PluginFactoryRegistry, StructureReconciler } from '../src/index.ts'

async function structure(
  modelVersion: string,
  sandboxVersion = '1',
): Promise<EffectiveStructure> {
  return resolveEffectiveStructure(
    BundleSchema.parse({
      id: 'test',
      version: `${modelVersion}-${sandboxVersion}`,
      model: { id: 'model', version: modelVersion },
      prompt: { id: 'prompt', version: '1' },
      contextPolicy: { id: 'context', version: '1' },
      memoryView: { id: 'memory', version: '1' },
      sandbox: { id: 'sandbox', version: sandboxVersion },
      evalPolicy: { id: 'eval', version: '1' },
    }),
  )
}

function store(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerStructureChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

function provider(
  id: string,
  service: string,
  value: unknown,
  config: unknown,
  replacementTier: 'b' | 'c' = 'b',
): RuntimePlugin {
  return {
    id,
    version: '1.0.0',
    config,
    replacementTier,
    provides: [service],
    apply(ctx) {
      ctx.provide(service, value)
    },
  }
}

async function eventTypes(
  chronicle: MemoryChronicleStore,
): Promise<readonly string[]> {
  const types: string[] = []
  for await (const event of chronicle.readStream(STRUCTURE_STREAM_ID)) {
    types.push(event.eventType)
  }
  return types
}

describe('PluginFactoryRegistry', () => {
  it('builds plugins in registration order and rejects duplicate factories', async () => {
    const factories = new PluginFactoryRegistry()
    factories.register({
      id: 'first',
      create: (selected) =>
        provider(
          'model',
          'llm',
          selected.model.ref.version,
          selected.model.ref,
        ),
    })
    factories.register({
      id: 'second',
      create: () => provider('tools', 'tools', {}, {}),
    })
    expect(() =>
      factories.register({ id: 'first', create: () => null }),
    ).toThrow(/already registered/)

    const graph = await factories.createGraph(await structure('a'))
    expect(graph.plugins.map((plugin) => plugin.id)).toEqual(['model', 'tools'])
  })
})

describe('StructureReconciler', () => {
  it('persists activation, switches B-tier providers, and restores after restart', async () => {
    const chronicle = store()
    const factories = new PluginFactoryRegistry()
    factories.register({
      id: 'runtime',
      create: (selected) => [
        provider('store', 'store', {}, { filename: 'bee.sqlite' }, 'c'),
        provider(
          'model',
          'llm',
          selected.model.ref.version,
          selected.model.ref,
        ),
      ],
    })
    const reconciler = new StructureReconciler({
      store: chronicle,
      factories,
    })
    const before = await structure('a')
    const after = await structure('b')
    await reconciler.reconcile(before)
    expect(reconciler.kernel.service('llm')).toBe('a')
    const switched = await reconciler.reconcile(after)
    expect(switched.kind).toBe('activated')
    expect(reconciler.kernel.service('llm')).toBe('b')
    await reconciler.stop()

    const restarted = new StructureReconciler({
      store: chronicle,
      factories,
    })
    const restored = await restarted.restore()
    expect(restored?.kind).toBe('activated')
    expect(restarted.kernel.service('llm')).toBe('b')
    expect(await eventTypes(chronicle)).toContain(
      STRUCTURE_ACTIVATED_EVENT_TYPE,
    )
    await restarted.stop()
  })

  it('keeps the active generation and records failed factory resolution', async () => {
    const chronicle = store()
    const factories = new PluginFactoryRegistry()
    factories.register({
      id: 'model',
      create(selected) {
        if (selected.model.ref.version === 'broken') {
          throw new Error('model unavailable')
        }
        return provider(
          'model',
          'llm',
          selected.model.ref.version,
          selected.model.ref,
        )
      },
    })
    const reconciler = new StructureReconciler({
      store: chronicle,
      factories,
    })
    await reconciler.reconcile(await structure('stable'))
    await expect(
      reconciler.reconcile(await structure('broken')),
    ).rejects.toThrow(/model unavailable/)
    expect(reconciler.kernel.service('llm')).toBe('stable')
    expect(await eventTypes(chronicle)).toContain(
      STRUCTURE_ACTIVATION_FAILED_EVENT_TYPE,
    )
    await reconciler.stop()
  })

  it('records restart-required only when a C-tier plugin changes', async () => {
    const chronicle = store()
    const factories = new PluginFactoryRegistry()
    factories.register({
      id: 'sandbox',
      create: (selected) =>
        provider(
          'sandbox',
          'sandbox',
          selected.sandbox.ref.version,
          selected.sandbox.ref,
          'c',
        ),
    })
    const reconciler = new StructureReconciler({
      store: chronicle,
      factories,
    })
    await reconciler.reconcile(await structure('a', '1'))
    const result = await reconciler.reconcile(await structure('a', '2'))
    expect(result).toEqual({
      kind: 'restart-required',
      pluginIds: ['sandbox'],
    })
    expect(await eventTypes(chronicle)).toEqual(
      expect.arrayContaining([
        STRUCTURE_RESOLVED_EVENT_TYPE,
        STRUCTURE_RESTART_REQUIRED_EVENT_TYPE,
      ]),
    )
    await reconciler.stop()
  })

  it('serializes concurrent desired-state updates in invocation order', async () => {
    const chronicle = store()
    const factories = new PluginFactoryRegistry()
    factories.register({
      id: 'model',
      async create(selected) {
        if (selected.model.ref.version === 'b') {
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        return provider(
          'model',
          'llm',
          selected.model.ref.version,
          selected.model.ref,
        )
      },
    })
    const reconciler = new StructureReconciler({
      store: chronicle,
      factories,
    })
    await reconciler.reconcile(await structure('a'))
    const updateB = reconciler.reconcile(await structure('b'))
    const updateC = reconciler.reconcile(await structure('c'))
    await Promise.all([updateB, updateC])
    expect(reconciler.kernel.service('llm')).toBe('c')
    await reconciler.stop()
  })
})
