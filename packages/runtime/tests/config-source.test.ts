import { describe, expect, it } from 'vitest'
import { BundleSchema, resolveEffectiveStructure } from '@bee-agent/kernel'
import type { ConfigSource } from '../src/index.ts'
import {
  PluginFactoryRegistry,
  StructureConfigController,
  StructureReconciler,
} from '../src/index.ts'
import { ChronicleSchemaRegistry } from '@bee-agent/knowledge'
import { registerStructureChronicleEvents } from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'

async function structure(version: string) {
  return resolveEffectiveStructure(
    BundleSchema.parse({
      id: 'test',
      version,
      model: { id: 'model', version },
      prompt: { id: 'p', version: '1' },
      contextPolicy: { id: 'c', version: '1' },
      memoryView: { id: 'mv', version: '1' },
      sandbox: { id: 's', version: '1' },
      evalPolicy: { id: 'e', version: '1' },
    }),
  )
}

describe('StructureConfigController', () => {
  it('reconciles source changes and keeps the active generation on failure', async () => {
    const registry = new ChronicleSchemaRegistry()
    registerStructureChronicleEvents(registry)
    const factories = new PluginFactoryRegistry()
    factories.register({
      id: 'model',
      create(selected) {
        const value = selected.model.ref.version
        if (value === 'broken') throw new Error('unavailable')
        return {
          id: 'model',
          version: '1',
          config: value,
          provides: ['llm'],
          apply(ctx) {
            ctx.provide('llm', value)
          },
        }
      },
    })
    let selected = await structure('a')
    let notify: () => void = () => undefined
    const source: ConfigSource = {
      id: 'memory:test',
      async load() {
        return selected
      },
      subscribe(listener) {
        notify = listener
        return () => undefined
      },
    }
    const reconciler = new StructureReconciler({
      store: new MemoryChronicleStore(registry),
      factories,
    })
    const controller = new StructureConfigController(source, reconciler)
    await controller.start()
    expect(reconciler.kernel.service('llm')).toBe('a')

    selected = await structure('b')
    notify()
    await controller.settled()
    expect(reconciler.kernel.service('llm')).toBe('b')

    selected = await structure('broken')
    notify()
    await controller.settled()
    expect(reconciler.kernel.service('llm')).toBe('b')
    expect(controller.inspect().lastError).toMatch(/unavailable/)
    await controller.stop()
    await reconciler.stop()
  })
})
