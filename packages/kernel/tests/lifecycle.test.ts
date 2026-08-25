import { describe, expect, it } from 'vitest'
import { PluginManifestSchema } from '@bee-agent/plugin-sdk'
import type { PluginManifest } from '@bee-agent/plugin-sdk'
import {
  EffectScope,
  createKernel,
  type LifecycleBeeAgentPlugin,
} from '../src/index.ts'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createFakeManifest(
  overrides: Partial<PluginManifest> = {},
): PluginManifest {
  return PluginManifestSchema.parse({
    id: 'fake-lifecycle',
    name: 'Fake Lifecycle Plugin',
    version: '0.0.1',
    engine: { pluginApi: '^0.1' },
    entry: 'dist/index.js',
    ...overrides,
  })
}

/**
 * Fault-injectable Bee Agent plugin: every lifecycle stage can delay, fail,
 * or be observed. Hooks beyond start/stop are optional by contract.
 */
class FakeLifecyclePlugin implements LifecycleBeeAgentPlugin {
  readonly manifest: PluginManifest
  readonly stopCalls: number[] = []
  drainCalls = 0
  healthCalls = 0
  startDelayMs = 0
  stopError: Error | undefined
  drainDelayMs = 0
  drainError: Error | undefined
  health: { status: 'healthy' | 'degraded' | 'unhealthy'; detail?: string } = {
    status: 'healthy',
  }

  constructor(manifestId = 'fake-lifecycle') {
    this.manifest = createFakeManifest({ id: manifestId })
  }

  async start(): Promise<void> {
    if (this.startDelayMs > 0) await delay(this.startDelayMs)
  }

  async stop(): Promise<void> {
    this.stopCalls.push(Date.now())
    if (this.stopError) throw this.stopError
  }

  async drain(): Promise<{ timedOut: boolean }> {
    this.drainCalls += 1
    if (this.drainDelayMs > 0) await delay(this.drainDelayMs)
    if (this.drainError) throw this.drainError
    return { timedOut: false }
  }

  async healthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy'
    detail?: string
  }> {
    this.healthCalls += 1
    return this.health
  }
}

describe('EffectScope', () => {
  it('releases disposers in reverse registration order, awaiting async ones', async () => {
    const scope = new EffectScope()
    const calls: string[] = []
    scope.add(() => {
      calls.push('first')
    })
    scope.add(async () => {
      await delay(5)
      calls.push('second')
    })
    scope.add(() => {
      calls.push('third')
    })

    const result = await scope.release()
    expect(calls).toEqual(['third', 'second', 'first'])
    expect(result).toEqual({ released: 3, failures: [] })
    expect(scope.size).toBe(0)
    expect(scope.released).toBe(true)
  })

  it('keeps releasing when a disposer throws and reports every failure', async () => {
    const scope = new EffectScope()
    const calls: string[] = []
    scope.add(() => {
      calls.push('first')
    })
    scope.add(
      () => {
        throw new Error('sync boom')
      },
      { label: 'sync-boom' },
    )
    scope.add(
      async () => {
        throw new Error('async boom')
      },
      { label: 'async-boom' },
    )

    const result = await scope.release()
    expect(calls).toEqual(['first'])
    expect(result.released).toBe(1)
    expect(result.failures).toHaveLength(2)
    expect(result.failures[0]?.label).toBe('async-boom')
    expect(result.failures[0]?.error).toBeInstanceOf(Error)
    expect(result.failures[1]?.label).toBe('sync-boom')
  })

  it('rejects registration after release, honors unregistration, and is idempotent', async () => {
    const scope = new EffectScope()
    const calls: string[] = []
    scope.add(() => {
      calls.push('kept')
    })
    const off = scope.add(() => {
      calls.push('dropped')
    })
    off()
    off()
    expect(scope.size).toBe(1)

    const first = scope.release()
    const second = scope.release()
    await expect(second).toBe(first)
    expect(calls).toEqual(['kept'])

    expect(() => scope.add(() => undefined)).toThrow(/already released/)
    // Repeated release replays the original report, never runs new work.
    const third = await scope.release()
    expect(third).toEqual({ released: 1, failures: [] })
  })
})

describe('TaskScope fault injection', () => {
  it('aggregates effect failures but still completes teardown', async () => {
    const kernel = createKernel()
    await kernel.start()
    const scope = kernel.createTaskScope('task-1')
    const calls: string[] = []
    let cordisReleased = false
    scope.onDispose(() => {
      calls.push('first')
    })
    scope.onDispose(async () => {
      throw new Error('async dispose boom')
    })
    scope.onDispose(() => {
      throw new Error('sync dispose boom')
    })
    scope.context.effect(() => () => {
      cordisReleased = true
    })

    await expect(scope.dispose()).rejects.toThrow(AggregateError)
    expect(calls).toEqual(['first'])
    expect(cordisReleased).toBe(true)
    expect(scope.disposed).toBe(true)
    expect(kernel.getTaskScope('task-1')).toBeUndefined()
    await kernel.stop()
  })
})

describe('Plugin drain and health checks', () => {
  it('reports immediate drain and healthy status for hook-less plugins', async () => {
    const kernel = createKernel()
    const bare: LifecycleBeeAgentPlugin = {
      manifest: createFakeManifest({ id: 'bare-plugin' }),
      start: () => undefined,
      stop: () => undefined,
    }
    const handle = kernel.useBeeAgentPlugin(bare)
    await kernel.start()

    await expect(handle.drain({ timeoutMs: 10 })).resolves.toEqual({
      timedOut: false,
    })
    await expect(handle.healthCheck()).resolves.toEqual({ status: 'healthy' })
    await kernel.stop()
  })

  it('delegates drain and health checks to the plugin hooks', async () => {
    const kernel = createKernel()
    const plugin = new FakeLifecyclePlugin()
    plugin.health = { status: 'degraded', detail: 'connection flaky' }
    const handle = kernel.useBeeAgentPlugin(plugin)
    await kernel.start()

    await expect(handle.drain()).resolves.toEqual({ timedOut: false })
    await expect(handle.healthCheck()).resolves.toEqual({
      status: 'degraded',
      detail: 'connection flaky',
    })
    expect(plugin.drainCalls).toBe(1)
    expect(plugin.healthCalls).toBe(1)
    await kernel.stop()
  })

  it('reports a timed-out drain instead of hanging or rejecting', async () => {
    const kernel = createKernel()
    const plugin = new FakeLifecyclePlugin()
    plugin.drainDelayMs = 60
    const handle = kernel.useBeeAgentPlugin(plugin)
    await kernel.start()

    await expect(handle.drain({ timeoutMs: 5 })).resolves.toEqual({
      timedOut: true,
    })
    await kernel.stop()
  })

  it('propagates drain failures that happen before the timeout', async () => {
    const kernel = createKernel()
    const plugin = new FakeLifecyclePlugin()
    plugin.drainError = new Error('drain exploded')
    const handle = kernel.useBeeAgentPlugin(plugin)
    await kernel.start()

    await expect(handle.drain({ timeoutMs: 1000 })).rejects.toThrow(
      'drain exploded',
    )
    await kernel.stop()
  })
})

describe('Plugin quarantine', () => {
  it('quarantines a plugin whose stop fails and never force-cleans it', async () => {
    const kernel = createKernel()
    const plugin = new FakeLifecyclePlugin()
    plugin.stopError = new Error('stop exploded')
    const handle = kernel.useBeeAgentPlugin(plugin, {
      services: { 'sticky-service': { value: 1 } },
    })
    await kernel.start()
    await handle.ready

    const quarantined: string[] = []
    const unmounted: string[] = []
    kernel.on('plugin-quarantined', ({ id, pluginId }) => {
      quarantined.push(`${id}:${pluginId}`)
    })
    kernel.on('plugin-unmounted', ({ id }) => {
      unmounted.push(id)
    })

    await expect(handle.dispose()).rejects.toThrow('stop exploded')
    expect(handle.status).toBe('quarantined')
    expect(handle.disposed).toBe(false)
    expect(handle.quarantineError).toBe(plugin.stopError)
    expect(quarantined).toEqual([`${handle.id}:fake-lifecycle`])
    expect(unmounted).toEqual([])
    expect(kernel.restartRequired).toBe(true)
    expect(kernel.quarantinedPlugins).toEqual([
      { id: handle.id, pluginId: 'fake-lifecycle', error: plugin.stopError },
    ])

    // No forced overwrite: repeated dispose is a no-op and stop stays at one
    // attempt. The cordis fork is already torn down (services released), but
    // the plugin's own half-failed state is never touched again.
    await expect(handle.dispose()).resolves.toBeUndefined()
    expect(plugin.stopCalls).toHaveLength(1)
    expect(kernel.getService('sticky-service')).toBeUndefined()
    await kernel.stop()
    expect(kernel.restartRequired).toBe(true)
  })

  it('reports quarantined handles as unhealthy by default', async () => {
    const kernel = createKernel()
    const bare: LifecycleBeeAgentPlugin = {
      manifest: createFakeManifest({ id: 'bare-plugin' }),
      start: () => undefined,
      stop: () => {
        throw new Error('stop exploded')
      },
    }
    const handle = kernel.useBeeAgentPlugin(bare)
    await kernel.start()
    await expect(handle.dispose()).rejects.toThrow('stop exploded')

    await expect(handle.healthCheck()).resolves.toEqual({
      status: 'unhealthy',
      detail: 'plugin is quarantined',
    })
    await kernel.stop()
  })

  it('refuses remounting a quarantined plugin id until restart', async () => {
    const kernel = createKernel()
    const failing = new FakeLifecyclePlugin()
    failing.stopError = new Error('stop exploded')
    const handle = kernel.useBeeAgentPlugin(failing)
    await kernel.start()
    await expect(handle.dispose()).rejects.toThrow('stop exploded')

    expect(() => kernel.useBeeAgentPlugin(new FakeLifecyclePlugin())).toThrow(
      /fake-lifecycle.*quarantined.*restart/,
    )
    // A differently-identified plugin still mounts fine.
    const other = new FakeLifecyclePlugin('other-plugin')
    expect(() => kernel.useBeeAgentPlugin(other)).not.toThrow()
    await kernel.stop()
  })

  it('records quarantine when stop fails during kernel shutdown', async () => {
    const kernel = createKernel()
    const plugin = new FakeLifecyclePlugin()
    plugin.stopError = new Error('shutdown stop exploded')
    kernel.useBeeAgentPlugin(plugin)
    await kernel.start()

    await expect(kernel.stop()).rejects.toThrow('shutdown stop exploded')
    expect(kernel.state).toBe('stopped')
    expect(kernel.restartRequired).toBe(true)
    expect(kernel.quarantinedPlugins[0]?.pluginId).toBe('fake-lifecycle')
  })
})

describe('Kernel teardown ordering', () => {
  it('disposes plugins in reverse mount order', async () => {
    const kernel = createKernel()
    await kernel.start()
    const stopOrder: string[] = []
    const mount = (id: string): FakeLifecyclePlugin => {
      const plugin = new FakeLifecyclePlugin(id)
      plugin.stop = async () => {
        stopOrder.push(id)
      }
      kernel.useBeeAgentPlugin(plugin)
      return plugin
    }
    mount('plugin-a')
    mount('plugin-b')
    mount('plugin-c')

    await kernel.stop()
    expect(stopOrder).toEqual(['plugin-c', 'plugin-b', 'plugin-a'])
  })

  it('disposes task scopes in reverse creation order', async () => {
    const kernel = createKernel()
    await kernel.start()
    const disposeOrder: string[] = []
    const open = (taskId: string): void => {
      const scope = kernel.createTaskScope(taskId)
      scope.onDispose(() => {
        disposeOrder.push(taskId)
      })
    }
    open('task-1')
    open('task-2')
    open('task-3')

    await kernel.stop()
    expect(disposeOrder).toEqual(['task-3', 'task-2', 'task-1'])
  })
})
