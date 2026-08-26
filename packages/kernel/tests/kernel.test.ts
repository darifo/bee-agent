import { describe, expect, it } from 'vitest'
import {
  ContextPolicy,
  DuplicateServiceProviderError,
  MissingPluginDependencyError,
  PluginDependencyCycleError,
  RestrictedServiceAccessError,
  StructureVersionCollisionError,
  createKernel,
  createReconcilePlan,
} from '../src/index.ts'
import type { PluginGraph, RuntimePlugin } from '../src/index.ts'
import type { Context } from '../src/index.ts'

interface ModelContext extends Context {
  readonly llm: { readonly model: string }
}

function provider(
  id: string,
  service: string,
  value: unknown,
  dispose?: () => void | Promise<void>,
): RuntimePlugin {
  return {
    id,
    version: '1.0.0',
    provides: [service],
    apply(ctx) {
      ctx.provide(service, value)
      if (dispose !== undefined) ctx.effect(() => dispose, `${id}:dispose`)
    },
  }
}

function graph(
  structureVersion: string,
  plugins: readonly RuntimePlugin[],
): PluginGraph {
  return { structureVersion, plugins }
}

describe('Kernel plugin graph', () => {
  it('activates plugins in dependency order and resolves proxy services', async () => {
    const observations: string[] = []
    const kernel = createKernel()
    const result = await kernel.reconcile(
      graph('structure-a', [
        {
          id: 'consumer',
          version: '1.0.0',
          inject: ['llm'],
          provides: ['agentLoop'],
          apply(ctx) {
            const llm = (ctx as ModelContext).llm
            observations.push(llm.model)
            ctx.provide('agentLoop', { model: llm.model })
          },
        },
        provider('model', 'llm', { model: 'test-model' }),
      ]),
    )

    expect(result.kind).toBe('activated')
    expect(observations).toEqual(['test-model'])
    expect(kernel.service<{ model: string }>('agentLoop').model).toBe(
      'test-model',
    )
    expect(kernel.inspect()[0]?.fibers.map((fiber) => fiber.pluginId)).toEqual([
      'model',
      'consumer',
    ])
    await kernel.stop()
  })

  it('fails before activation on missing dependencies', async () => {
    const kernel = createKernel()
    await expect(
      kernel.reconcile(
        graph('missing', [
          {
            id: 'consumer',
            version: '1.0.0',
            inject: ['llm'],
            apply() {},
          },
        ]),
      ),
    ).rejects.toBeInstanceOf(MissingPluginDependencyError)
  })

  it('rejects proxy service access that was not declared in dependencies', async () => {
    const kernel = createKernel()
    await expect(
      kernel.reconcile(
        graph('undeclared', [
          provider('model', 'llm', { model: 'test' }),
          {
            id: 'consumer',
            version: '1.0.0',
            apply(ctx) {
              void (ctx as ModelContext).llm
            },
          },
        ]),
      ),
    ).rejects.toThrow(/without inject/)
  })

  it('detects dependency cycles and duplicate providers', async () => {
    const kernel = createKernel()
    await expect(
      kernel.reconcile(
        graph('cycle', [
          {
            id: 'a',
            version: '1.0.0',
            provides: ['a'],
            inject: ['b'],
            apply(ctx) {
              ctx.provide('a', {})
            },
          },
          {
            id: 'b',
            version: '1.0.0',
            provides: ['b'],
            inject: ['a'],
            apply(ctx) {
              ctx.provide('b', {})
            },
          },
        ]),
      ),
    ).rejects.toBeInstanceOf(PluginDependencyCycleError)

    await expect(
      kernel.reconcile(
        graph('duplicates', [
          provider('one', 'llm', {}),
          provider('two', 'llm', {}),
        ]),
      ),
    ).rejects.toBeInstanceOf(DuplicateServiceProviderError)
  })
})

describe('Kernel generations', () => {
  it('applies config-only A-tier changes in place and rolls back failures', async () => {
    const kernel = createKernel()
    const configurable = (value: string): RuntimePlugin<string> => ({
      id: 'model',
      version: '1.0.0',
      config: value,
      replacementTier: 'a',
      provides: ['llm'],
      apply(ctx, config) {
        if (config === 'broken') throw new Error('bad config')
        ctx.provide('llm', config)
      },
    })
    await kernel.reconcile(graph('a', [configurable('a')]))
    const generationId = kernel.activeGeneration?.id
    const updated = await kernel.reconcile(graph('b', [configurable('b')]))
    expect(updated.kind).toBe('updated')
    expect(kernel.activeGeneration?.id).toBe(generationId)
    expect(kernel.service('llm')).toBe('b')

    await expect(
      kernel.reconcile(graph('broken', [configurable('broken')])),
    ).rejects.toThrow(/bad config/)
    expect(kernel.activeGeneration?.structureVersion).toBe('b')
    expect(kernel.service('llm')).toBe('b')
    await kernel.stop()
  })

  it('promotes A-tier topology changes to a generation swap', () => {
    const before = {
      ...provider('model', 'llm', 'a'),
      replacementTier: 'a' as const,
      config: 'a',
    }
    const after = { ...before, version: '2.0.0', config: 'b' }
    expect(createReconcilePlan([before], [after])).toMatchObject({
      kind: 'generation-swap',
      changes: [{ pluginId: 'model', kind: 'replaced', tier: 'b' }],
    })
  })

  it('uses a generation swap for an A-tier config update pinned by a Turn', async () => {
    const kernel = createKernel()
    const configurable = (value: string): RuntimePlugin<string> => ({
      id: 'model',
      version: '1',
      config: value,
      replacementTier: 'a',
      provides: ['llm'],
      apply(ctx, config) {
        ctx.provide('llm', config)
      },
    })
    await kernel.reconcile(graph('a', [configurable('a')]))
    const oldTurn = kernel.beginTurn()
    const oldGenerationId = oldTurn.generation.id
    const result = await kernel.reconcile(graph('b', [configurable('b')]))
    expect(result.kind).toBe('activated')
    expect(kernel.activeGeneration?.id).not.toBe(oldGenerationId)
    expect(oldTurn.service('llm')).toBe('a')
    expect(kernel.service('llm')).toBe('b')
    oldTurn.release()
    await kernel.stop()
  })

  it('keeps a draining generation alive until its Turn lease releases', async () => {
    const disposed: string[] = []
    const kernel = createKernel()
    await kernel.reconcile(
      graph('a', [
        provider('model', 'llm', { model: 'a' }, () => {
          disposed.push('a')
        }),
      ]),
    )
    const oldTurn = kernel.beginTurn()
    expect(oldTurn.service<{ model: string }>('llm').model).toBe('a')

    await kernel.reconcile(
      graph('b', [
        provider('model', 'llm', { model: 'b' }, () => {
          disposed.push('b')
        }),
      ]),
    )
    expect(kernel.service<{ model: string }>('llm').model).toBe('b')
    expect(oldTurn.service<{ model: string }>('llm').model).toBe('a')
    expect(disposed).toEqual([])

    oldTurn.release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(disposed).toEqual(['a'])
    expect(kernel.inspect().map((entry) => entry.structureVersion)).toEqual([
      'b',
    ])
    await kernel.stop()
    expect(disposed).toEqual(['a', 'b'])
  })

  it('keeps the active generation when a candidate fails', async () => {
    const kernel = createKernel()
    await kernel.reconcile(graph('a', [provider('model', 'llm', 'stable')]))

    await expect(
      kernel.reconcile(
        graph('b', [
          {
            id: 'broken',
            version: '1.0.0',
            apply() {
              throw new Error('boom')
            },
          },
        ]),
      ),
    ).rejects.toThrow(/failed to activate/)
    expect(kernel.activeGeneration?.structureVersion).toBe('a')
    expect(kernel.service<string>('llm')).toBe('stable')
    await kernel.stop()
  })

  it('quarantines cleanup failures without rolling back the activated candidate', async () => {
    const kernel = createKernel()
    await kernel.reconcile(
      graph('a', [
        provider('model', 'llm', 'a', () => {
          throw new Error('cleanup failed')
        }),
      ]),
    )
    const result = await kernel.reconcile(
      graph('b', [{ ...provider('model', 'llm', 'b'), config: 'b' }]),
    )
    expect(result.kind).toBe('activated')
    expect(kernel.service('llm')).toBe('b')
    expect(kernel.doctor()).toMatchObject({
      healthy: false,
      quarantines: [{ error: expect.stringMatching(/failed to dispose/) }],
      issues: [{ code: 'cleanup-failed', severity: 'error' }],
    })
    await kernel.stop()
  })

  it('requires a restart for tier-C changes once running', async () => {
    const kernel = createKernel()
    await kernel.reconcile(graph('a', [provider('store', 'store', {})]))
    const result = await kernel.reconcile(
      graph('b', [
        {
          ...provider('store', 'store', {}),
          config: { filename: 'b.sqlite' },
          replacementTier: 'c',
        },
      ]),
    )
    expect(result).toEqual({ kind: 'restart-required', pluginIds: ['store'] })
    expect(kernel.restartRequired).toBe(true)
    expect(kernel.restartRequiredPlugins).toEqual(['store'])
    expect(kernel.activeGeneration?.structureVersion).toBe('a')
    await kernel.stop()
  })

  it('allows a B-tier change when an unchanged C-tier provider remains', async () => {
    const kernel = createKernel()
    const store = {
      ...provider('store', 'store', {}),
      replacementTier: 'c' as const,
      config: { filename: 'bee.sqlite' },
    }
    await kernel.reconcile(
      graph('a', [store, { ...provider('model', 'llm', 'a'), config: 'a' }]),
    )
    const result = await kernel.reconcile(
      graph('b', [store, { ...provider('model', 'llm', 'b'), config: 'b' }]),
    )
    expect(result.kind).toBe('activated')
    expect(kernel.service('llm')).toBe('b')
    await kernel.stop()
  })

  it('rejects reusing a structure version for a different graph', async () => {
    const kernel = createKernel()
    await kernel.reconcile(
      graph('same', [
        { ...provider('model', 'llm', 'a'), config: { model: 'a' } },
      ]),
    )
    await expect(
      kernel.reconcile(
        graph('same', [
          { ...provider('model', 'llm', 'b'), config: { model: 'b' } },
        ]),
      ),
    ).rejects.toBeInstanceOf(StructureVersionCollisionError)
    await kernel.stop()
  })
})

describe('ContextPolicy', () => {
  it('only narrows service visibility across derived scopes', async () => {
    const kernel = createKernel()
    await kernel.reconcile(
      graph('a', [
        provider('model', 'llm', {}),
        provider('tools', 'tools', {}),
      ]),
    )
    const turn = kernel.beginTurn(new ContextPolicy(['llm', 'tools']))
    const child = turn.scope.derive(['tools', 'secret'])
    expect(child.service('tools')).toEqual({})
    expect(() => child.service('llm')).toThrow(RestrictedServiceAccessError)
    expect(() => child.service('secret')).toThrow(RestrictedServiceAccessError)
    turn.release()
    await kernel.stop()
  })
})
