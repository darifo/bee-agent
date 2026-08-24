import { describe, expect, it } from 'vitest'
import { PluginManifestSchema } from '@bee-agent/plugin-sdk'
import type { BeeAgentPlugin, PluginManifest } from '@bee-agent/plugin-sdk'
import {
  createKernel,
  defineSerialEvent,
  defineServiceKey,
  defineWaterfallEvent,
  eventStoreService,
  storageService,
  vectorStoreService,
} from '../src/index.js'
import type { Context, KernelEvents } from '../src/index.js'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createFakeManifest(
  overrides: Partial<PluginManifest> = {},
): PluginManifest {
  return PluginManifestSchema.parse({
    id: 'fake-storage',
    name: 'Fake Storage',
    version: '0.0.1',
    engine: { pluginApi: '^0.1' },
    entry: 'dist/index.js',
    ...overrides,
  })
}

class FakeBeeAgentPlugin implements BeeAgentPlugin {
  readonly manifest = createFakeManifest()
  readonly store = { tag: 'fake' }
  startAttempts = 0
  stopAttempts = 0
  stopCompleted = false
  startDelayMs = 0
  startError: Error | undefined

  async start(): Promise<void> {
    if (this.startDelayMs > 0) await delay(this.startDelayMs)
    this.startAttempts += 1
    if (this.startError) throw this.startError
  }

  async stop(): Promise<void> {
    this.stopAttempts += 1
    await delay(5)
    this.stopCompleted = true
  }
}

describe('Kernel', () => {
  it('registers services and releases task-scoped effects', async () => {
    const kernel = createKernel()
    await kernel.start()

    const service = { answer: 42 }
    const unregister = kernel.registerService('answerService', service)
    expect(kernel.context.get('answerService')).toBe(service)

    const scope = kernel.createTaskScope('task-1')
    let released = false
    scope.context.effect(() => () => {
      released = true
    })
    await scope.dispose()

    expect(scope.disposed).toBe(true)
    expect(released).toBe(true)
    unregister()
    expect(kernel.context.get('answerService')).toBeUndefined()
    await kernel.stop()
  })

  it('requires the root context to be started before opening a task scope', () => {
    const kernel = createKernel()
    expect(() => kernel.createTaskScope('task-1')).toThrow(/started/)
  })

  it('tracks state transitions and emits state-change events', async () => {
    const kernel = createKernel()
    const transitions: string[] = []
    kernel.on('state-changed', ({ from, to }) => {
      transitions.push(`${from}->${to}`)
    })

    expect(kernel.state).toBe('created')
    await kernel.start()
    expect(kernel.state).toBe('started')
    expect(kernel.started).toBe(true)
    await kernel.stop()
    expect(kernel.state).toBe('stopped')
    expect(kernel.started).toBe(false)

    expect(transitions).toEqual([
      'created->starting',
      'starting->started',
      'started->stopping',
      'stopping->stopped',
    ])
  })

  it('treats repeated start as a no-op and start after stop as an error', async () => {
    const kernel = createKernel()
    await kernel.start()
    await kernel.start()
    expect(kernel.state).toBe('started')

    await kernel.stop()
    await expect(kernel.start()).rejects.toThrow(/Cannot start kernel/)
    expect(kernel.state).toBe('stopped')
  })

  it('treats stop before start as a no-op', async () => {
    const kernel = createKernel()
    await kernel.stop()
    expect(kernel.state).toBe('created')
    await kernel.start()
    expect(kernel.state).toBe('started')
    await kernel.stop()
  })
})

describe('Kernel services', () => {
  it('resolves typed service keys', async () => {
    interface AnswerService {
      answer: number
    }
    const answerKey = defineServiceKey<AnswerService>('answer')

    const kernel = createKernel()
    await kernel.start()
    expect(kernel.getService(answerKey)).toBeUndefined()
    expect(kernel.hasService(answerKey)).toBe(false)

    kernel.registerService(answerKey, { answer: 42 })
    const resolved = kernel.getService(answerKey)
    expect(resolved?.answer).toBe(42)
    expect(kernel.hasService('answer')).toBe(true)
    await kernel.stop()
  })

  it('rejects duplicate service registration', async () => {
    const kernel = createKernel()
    await kernel.start()
    kernel.registerService('dup', { first: true })
    expect(() => kernel.registerService('dup', { second: true })).toThrow(
      /already registered/,
    )
    expect(kernel.getService('dup')).toEqual({ first: true })
    await kernel.stop()
  })

  it('refuses registration after shutdown', async () => {
    const kernel = createKernel()
    await kernel.start()
    await kernel.stop()
    expect(() => kernel.registerService('late', {})).toThrow(
      /kernel is 'stopped'/,
    )
  })

  it('emits service-registered and service-unregistered events', async () => {
    const kernel = createKernel()
    await kernel.start()
    const events: Array<
      [string, KernelEvents['service-registered']['service']]
    > = []
    kernel.on('service-registered', ({ name, service }) => {
      events.push([name, service])
    })
    let unregistered: string | undefined
    kernel.on('service-unregistered', ({ name }) => {
      unregistered = name
    })

    const unregister = kernel.registerService('tracked', { value: 1 })
    unregister()

    expect(events).toEqual([['tracked', { value: 1 }]])
    expect(unregistered).toBe('tracked')
    await kernel.stop()
  })

  it('resolves immediately when the service already exists', async () => {
    const kernel = createKernel()
    await kernel.start()
    kernel.registerService('ready-service', { ok: true })
    await expect(kernel.waitForService('ready-service')).resolves.toEqual({
      ok: true,
    })
    await kernel.stop()
  })

  it('resolves when the service is registered later', async () => {
    const kernel = createKernel()
    await kernel.start()
    const expected = { ok: true }
    const pending = kernel.waitForService('late-service')
    kernel.registerService('late-service', expected)
    await expect(pending).resolves.toBe(expected)
    await kernel.stop()
  })

  it('rejects on timeout', async () => {
    const kernel = createKernel()
    await kernel.start()
    await expect(
      kernel.waitForService('never-service', { timeoutMs: 10 }),
    ).rejects.toThrow(/Timed out/)
    await kernel.stop()
  })

  it('rejects pending waiters when the kernel stops', async () => {
    const kernel = createKernel()
    await kernel.start()
    const pending = kernel
      .waitForService('never-service')
      .catch((error: Error) => error.message)
    await kernel.stop()
    expect(await pending).toMatch(/Kernel stopped/)
    await expect(kernel.waitForService('after-stop')).rejects.toThrow(
      /kernel is 'stopped'/,
    )
  })
})

describe('Kernel task scopes', () => {
  it('rejects duplicate task scope ids', async () => {
    const kernel = createKernel()
    await kernel.start()
    kernel.createTaskScope('task-1')
    expect(() => kernel.createTaskScope('task-1')).toThrow(/already exists/)
    await kernel.stop()
  })

  it('runs onDispose callbacks in reverse registration order', async () => {
    const kernel = createKernel()
    await kernel.start()
    const scope = kernel.createTaskScope('task-1')
    const calls: string[] = []
    scope.onDispose(() => {
      calls.push('first')
    })
    scope.onDispose(async () => {
      calls.push('second')
    })
    await scope.dispose()
    expect(calls).toEqual(['second', 'first'])
    await kernel.stop()
  })

  it('supports unregistering onDispose callbacks', async () => {
    const kernel = createKernel()
    await kernel.start()
    const scope = kernel.createTaskScope('task-1')
    let called = false
    const off = scope.onDispose(() => {
      called = true
    })
    off()
    await scope.dispose()
    expect(called).toBe(false)
    await kernel.stop()
  })

  it('refuses onDispose after disposal', async () => {
    const kernel = createKernel()
    await kernel.start()
    const scope = kernel.createTaskScope('task-1')
    await scope.dispose()
    expect(() => scope.onDispose(() => undefined)).toThrow(/already disposed/)
    await kernel.stop()
  })

  it('looks up and disposes scopes by task id', async () => {
    const kernel = createKernel()
    await kernel.start()
    const scope = kernel.createTaskScope('task-1')
    expect(kernel.getTaskScope('task-1')).toBe(scope)
    expect(kernel.taskScopes).toEqual([scope])

    expect(await kernel.disposeTaskScope('task-1')).toBe(true)
    expect(scope.disposed).toBe(true)
    expect(kernel.getTaskScope('task-1')).toBeUndefined()
    expect(kernel.taskScopes).toEqual([])
    expect(await kernel.disposeTaskScope('task-1')).toBe(false)
    await kernel.stop()
  })

  it('disposes all task scopes on kernel stop', async () => {
    const kernel = createKernel()
    await kernel.start()
    const scopeA = kernel.createTaskScope('task-a')
    const scopeB = kernel.createTaskScope('task-b')
    let released = false
    scopeB.onDispose(() => {
      released = true
    })

    await kernel.stop()
    expect(scopeA.disposed).toBe(true)
    expect(scopeB.disposed).toBe(true)
    expect(released).toBe(true)
    expect(kernel.taskScopes).toEqual([])
    expect(() => kernel.createTaskScope('task-c')).toThrow(/started/)
  })

  it('emits task-scope-created and task-scope-disposed events', async () => {
    const kernel = createKernel()
    await kernel.start()
    const events: string[] = []
    kernel.on('task-scope-created', ({ taskId }) => {
      events.push(`created:${taskId}`)
    })
    kernel.on('task-scope-disposed', ({ taskId }) => {
      events.push(`disposed:${taskId}`)
    })

    const scope = kernel.createTaskScope('task-1')
    await scope.dispose()
    expect(events).toEqual(['created:task-1', 'disposed:task-1'])
    await kernel.stop()
  })
})

describe('Kernel cordis plugin mounting', () => {
  it('mounts and unmounts cordis plugins with events', async () => {
    const kernel = createKernel()
    await kernel.start()

    let applied = false
    let cleaned = false
    const testPlugin = (context: Context): void => {
      applied = true
      context.effect(() => () => {
        cleaned = true
      })
    }

    const events: string[] = []
    kernel.on('plugin-mounted', ({ id }) => {
      events.push(`mounted:${id}`)
    })
    kernel.on('plugin-unmounted', ({ id }) => {
      events.push(`unmounted:${id}`)
    })

    const handle = kernel.use(testPlugin)
    expect(applied).toBe(true)
    expect(handle.context).toBeInstanceOf(Object)
    expect(handle.disposed).toBe(false)

    await handle.dispose()
    expect(cleaned).toBe(true)
    expect(handle.disposed).toBe(true)
    expect(events).toEqual([`mounted:${handle.id}`, `unmounted:${handle.id}`])
    await kernel.stop()
  })

  it('refuses mounting plugins after shutdown', async () => {
    const kernel = createKernel()
    await kernel.start()
    await kernel.stop()
    expect(() => kernel.use((context: Context) => void context)).toThrow(
      /kernel is 'stopped'/,
    )
  })
})

describe('Kernel Bee Agent plugin mounting', () => {
  it('starts Bee Agent plugins on kernel start and publishes their services', async () => {
    const kernel = createKernel()
    const plugin = new FakeBeeAgentPlugin()
    plugin.startDelayMs = 5

    const registered: string[] = []
    kernel.on('service-registered', ({ name }) => {
      registered.push(name)
    })

    const handle = kernel.useBeeAgentPlugin(plugin, {
      services: () => ({ 'fake-store': plugin.store }),
    })

    expect(kernel.hasService('fake-store')).toBe(false)
    await kernel.start()
    await handle.ready

    expect(plugin.startAttempts).toBe(1)
    expect(kernel.getService('fake-store')).toBe(plugin.store)
    expect(registered).toEqual(['fake-store'])
    expect(handle.plugin).toBe(plugin)

    await kernel.stop()
    expect(plugin.stopAttempts).toBe(1)
    expect(plugin.stopCompleted).toBe(true)
    expect(kernel.hasService('fake-store')).toBe(false)
  })

  it('awaits Bee Agent plugin stop before kernel stop returns', async () => {
    const kernel = createKernel()
    const plugin = new FakeBeeAgentPlugin()
    kernel.useBeeAgentPlugin(plugin)
    await kernel.start()
    expect(plugin.stopCompleted).toBe(false)
    await kernel.stop()
    expect(plugin.stopAttempts).toBe(1)
    expect(plugin.stopCompleted).toBe(true)
  })

  it('disposes Bee Agent plugins through the handle exactly once', async () => {
    const kernel = createKernel()
    const plugin = new FakeBeeAgentPlugin()
    const events: string[] = []
    kernel.on('plugin-unmounted', ({ id }) => {
      events.push(id)
    })

    const handle = kernel.useBeeAgentPlugin(plugin)
    await kernel.start()
    await handle.dispose()
    await handle.dispose()

    expect(plugin.stopAttempts).toBe(1)
    expect(plugin.stopCompleted).toBe(true)
    expect(events).toEqual([handle.id])
    await kernel.stop()
    expect(plugin.stopAttempts).toBe(1)
  })

  it('rejects ready and stops the plugin when start fails', async () => {
    const kernel = createKernel()
    const plugin = new FakeBeeAgentPlugin()
    plugin.startError = new Error('boom')

    const handle = kernel.useBeeAgentPlugin(plugin, {
      services: { unavailable: true },
    })
    await kernel.start()

    await expect(handle.ready).rejects.toThrow('boom')
    expect(plugin.startAttempts).toBe(1)
    expect(plugin.stopAttempts).toBe(1)
    expect(kernel.hasService('unavailable')).toBe(false)
    await kernel.stop()
    expect(plugin.stopAttempts).toBe(1)
  })
})

describe('Kernel domain events', () => {
  it('dispatches serial events to listeners in registration order', async () => {
    const kernel = createKernel()
    const order: string[] = []
    kernel.events.on('session/updated', () => {
      order.push('first')
    })
    kernel.events.on('session/updated', async () => {
      await delay(2)
      order.push('second')
    })
    await kernel.events.dispatch('session/updated', { seq: 1 })
    expect(order).toEqual(['first', 'second'])
  })

  it('supports typed event keys and listener disposal', async () => {
    const stepEvent = defineSerialEvent<{ step: number }>('agent/step')
    const kernel = createKernel()
    const seen: number[] = []
    const off = kernel.events.on(stepEvent, ({ step }) => {
      seen.push(step)
    })
    await kernel.events.dispatch(stepEvent, { step: 7 })
    off()
    await kernel.events.dispatch(stepEvent, { step: 8 })
    expect(seen).toEqual([7])
  })

  it('runs every listener and rethrows the first error', async () => {
    const kernel = createKernel()
    const calls: string[] = []
    kernel.events.on('flaky', () => {
      calls.push('a')
    })
    kernel.events.on('flaky', () => {
      calls.push('b')
      throw new Error('listener failed')
    })
    kernel.events.on('flaky', () => {
      calls.push('c')
    })
    await expect(kernel.events.dispatch('flaky', {})).rejects.toThrow(
      'listener failed',
    )
    expect(calls).toEqual(['a', 'b', 'c'])
  })

  it('runs waterfall middleware outermost-first around the terminal', async () => {
    const toolEvent = defineWaterfallEvent<
      { tool: string },
      { output: string }
    >('tools/execute')
    const kernel = createKernel()
    const calls: string[] = []
    kernel.events.use(toolEvent, async (payload, next) => {
      calls.push(`before:${payload.tool}`)
      const result = await next({ ...payload, tool: `${payload.tool}#1` })
      calls.push('after:outer')
      return result
    })
    kernel.events.use(toolEvent, async (payload, next) => {
      calls.push(`before:${payload.tool}`)
      const result = await next({ ...payload, tool: `${payload.tool}#2` })
      calls.push('after:inner')
      return result
    })

    const result = await kernel.events.waterfall(
      toolEvent,
      { tool: 'calc' },
      async (payload) => {
        calls.push(`terminal:${payload.tool}`)
        return { output: `ran ${payload.tool}` }
      },
    )

    expect(result).toEqual({ output: 'ran calc#1#2' })
    expect(calls).toEqual([
      'before:calc',
      'before:calc#1',
      'terminal:calc#1#2',
      'after:inner',
      'after:outer',
    ])
  })

  it('allows middleware to short-circuit without calling next', async () => {
    const kernel = createKernel()
    let terminalReached = false
    kernel.events.use('policy/check', async () => ({
      denied: true,
    }))
    const result = await kernel.events.waterfall(
      'policy/check',
      {},
      async () => {
        terminalReached = true
        return { denied: false }
      },
    )
    expect(result).toEqual({ denied: true })
    expect(terminalReached).toBe(false)
  })

  it('falls straight through to the terminal without middleware', async () => {
    const kernel = createKernel()
    const result = await kernel.events.waterfall(
      'noop',
      41,
      async (value) => value + 1,
    )
    expect(result).toBe(42)
  })
})

describe('TaskScope event bindings', () => {
  it('removes scope-registered listeners and middleware on disposal', async () => {
    const kernel = createKernel()
    await kernel.start()
    const scope = kernel.createTaskScope('task-1')
    const stepEvent = defineSerialEvent<{ step: number }>('agent/step')
    const seen: number[] = []
    scope.events.on(stepEvent, ({ step }) => {
      seen.push(step)
    })
    scope.events.use('policy/check', async () => ({ denied: true }))

    await kernel.events.dispatch('agent/step', { step: 1 })
    expect(seen).toEqual([1])

    await scope.dispose()
    await kernel.events.dispatch('agent/step', { step: 2 })
    expect(seen).toEqual([1])

    const result = await kernel.events.waterfall(
      'policy/check',
      {},
      async () => ({ denied: false }),
    )
    expect(result).toEqual({ denied: false })
    expect(() => scope.events).toThrow(/already disposed/)
    await kernel.stop()
  })
})

describe('Kernel service key catalog', () => {
  it('publishes storage, event-store, and vector-store keys', async () => {
    expect(storageService.name).toBe('storage')
    expect(eventStoreService.name).toBe('event-store')
    expect(vectorStoreService.name).toBe('vector-store')

    const kernel = createKernel()
    await kernel.start()
    const fakeStore = {
      append: async () => ({}) as never,
      appendBatch: async () => [] as never[],
      readTask: async function* () {},
      getLatestSequence: async () => 0,
      listTaskIds: async () => [] as readonly string[],
    }
    kernel.registerService(eventStoreService, fakeStore)
    expect(kernel.getService(eventStoreService)).toBe(fakeStore)
    await expect(kernel.waitForService(eventStoreService)).resolves.toBe(
      fakeStore,
    )
    await kernel.stop()
  })
})

describe('Kernel configuration', () => {
  it('forwards configuration to the Cordis root context', async () => {
    const kernel = createKernel({ config: { env: 'test', limit: 3 } })
    expect(kernel.config).toEqual({ env: 'test', limit: 3 })
    expect(kernel.context.config).toEqual({ env: 'test', limit: 3 })
    await kernel.start()
    await kernel.stop()
  })

  it('passes mount config to cordis plugins', async () => {
    const kernel = createKernel({ config: { env: 'test' } })
    await kernel.start()
    let seen: unknown
    kernel.use(
      (context: Context, config) => {
        seen = config
      },
      { own: 1 },
    )
    expect(seen).toEqual({ own: 1 })
    await kernel.stop()
  })

  it('defaults to an empty configuration', () => {
    const kernel = createKernel()
    expect(kernel.config ?? {}).toEqual({})
  })
})

describe('TaskScope service isolation', () => {
  it('gives the scope its own service slot without touching the global one', async () => {
    const kernel = createKernel()
    await kernel.start()
    let registeredEvents = 0
    kernel.on('service-registered', ({ name }) => {
      if (name === 'tools') registeredEvents += 1
    })
    const globalService = { where: 'global' }
    kernel.registerService('tools', globalService)
    expect(registeredEvents).toBe(1)

    const scope = kernel.createTaskScope('task-1')
    scope.isolateService('tools')
    const isolatedService = { where: 'isolated' }
    scope.context.set('tools', isolatedService)

    expect(scope.context.get('tools')).toBe(isolatedService)
    expect(kernel.getService('tools')).toBe(globalService)
    expect(registeredEvents).toBe(1)

    await scope.dispose()
    expect(kernel.getService('tools')).toBe(globalService)
    await kernel.stop()
  })

  it('shares one service slot between scopes of the same realm', async () => {
    const kernel = createKernel()
    await kernel.start()
    kernel.registerService('tools', { where: 'global' })

    const realm = Symbol('agent-preset')
    const scopeA = kernel.createTaskScope('task-a')
    const scopeB = kernel.createTaskScope('task-b')
    scopeA.isolateService('tools', realm)
    scopeB.isolateService('tools', realm)

    const realmService = { where: 'realm' }
    scopeA.context.set('tools', realmService)
    expect(scopeB.context.get('tools')).toBe(realmService)
    expect(kernel.getService('tools')).toEqual({ where: 'global' })

    await scopeA.dispose()
    await scopeB.dispose()
    await kernel.stop()
  })

  it('refuses isolation after disposal', async () => {
    const kernel = createKernel()
    await kernel.start()
    const scope = kernel.createTaskScope('task-1')
    await scope.dispose()
    expect(() => scope.isolateService('tools')).toThrow(/already disposed/)
    await kernel.stop()
  })
})
