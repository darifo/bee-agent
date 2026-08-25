import { Context } from 'cordis'
import type { Plugin } from 'cordis'
import { KernelEmitter } from './emitter.ts'
import { EventBus } from './events.ts'
import {
  CordisBeeAgentPluginHandle,
  prepareBeeAgentPluginMount,
} from './plugin-adapter.ts'
import { CordisPluginHandle } from './plugin-handle.ts'
import { forkTaskScope } from './task-scope.ts'
import type { CordisTaskScope } from './task-scope.ts'
import type {
  BeeAgentPluginHandle,
  BeeAgentPluginMountOptions,
  KernelConfig,
  KernelEventName,
  KernelEvents,
  KernelState,
  LifecycleBeeAgentPlugin,
  PluginHandle,
  PluginQuarantineEntry,
  ServiceKeyLike,
  TaskScope,
} from './types.ts'
import { serviceName } from './types.ts'

interface ServiceWaiter {
  fail(error: Error): void
}

export class Kernel {
  readonly context: Context

  readonly #events = new KernelEmitter()
  readonly #bus = new EventBus()
  readonly #taskScopes = new Map<string, CordisTaskScope>()
  readonly #plugins = new Map<string, PluginHandle>()
  readonly #quarantine = new Map<string, PluginQuarantineEntry>()
  readonly #waiters = new Set<ServiceWaiter>()
  #state: KernelState = 'created'
  #pluginCounter = 0

  constructor(config: KernelConfig = {}) {
    this.context = new Context(config.config)
    if (config.baseDir !== undefined) this.context.baseDir = config.baseDir
    // Single source of truth for service events, no matter which context in
    // the tree registered the service.
    this.context.on('internal/service', (name: string) => {
      const service = this.context.get(name)
      if (service !== undefined) {
        this.#events.emit('service-registered', { name, service })
      } else {
        this.#events.emit('service-unregistered', { name })
      }
    })
  }

  get state(): KernelState {
    return this.#state
  }

  get started(): boolean {
    return this.#state === 'started'
  }

  /** Application configuration forwarded to the Cordis root context. */
  get config(): Record<string, unknown> | undefined {
    return this.context.config as Record<string, unknown> | undefined
  }

  /** Domain event bus for serial and waterfall events across plugins. */
  get events(): EventBus {
    return this.#bus
  }

  get taskScopes(): readonly TaskScope[] {
    return [...this.#taskScopes.values()]
  }

  /** Plugins that failed to unload and were quarantined, oldest first. */
  get quarantinedPlugins(): readonly PluginQuarantineEntry[] {
    return [...this.#quarantine.values()]
  }

  /**
   * True once any plugin is quarantined: the process cannot clean up fully
   * and must be restarted before the affected plugin is touched again.
   */
  get restartRequired(): boolean {
    return this.#quarantine.size > 0
  }

  on<K extends KernelEventName>(
    event: K,
    listener: (payload: KernelEvents[K]) => void,
  ): () => void {
    return this.#events.on(event, listener)
  }

  async start(): Promise<void> {
    if (this.#state === 'started' || this.#state === 'starting') return
    if (this.#state !== 'created') {
      throw new Error(
        `Cannot start kernel in state '${this.#state}'; create a new kernel instead`,
      )
    }
    this.#setState('starting')
    try {
      await this.context.start()
      this.#setState('started')
    } catch (error) {
      this.#state = 'stopped'
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.#state !== 'started') return
    this.#setState('stopping')
    this.#failWaiters(
      new Error('Kernel stopped while waiting for services to register'),
    )
    const errors: unknown[] = []
    // Reverse creation/mount order: what was set up last is torn down first,
    // so dependencies are still alive while their users release resources.
    for (const scope of [...this.#taskScopes.values()].reverse()) {
      try {
        await scope.dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    for (const handle of [...this.#plugins.values()].reverse()) {
      try {
        await handle.dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    try {
      await this.context.stop()
    } catch (error) {
      errors.push(error)
    }
    this.#setState('stopped')
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Kernel stop encountered errors')
    }
  }

  registerService<T>(key: ServiceKeyLike<T>, service: T): () => void {
    const name = serviceName(key)
    this.#assertMutable(`Cannot register service '${name}'`)
    if (this.context.get(name) !== undefined) {
      throw new Error(`Service '${name}' is already registered`)
    }
    return this.context.set(name, service)
  }

  getService<T>(key: ServiceKeyLike<T>): T | undefined {
    return this.context.get(serviceName(key)) as T | undefined
  }

  hasService(key: ServiceKeyLike<unknown>): boolean {
    return this.context.get(serviceName(key)) !== undefined
  }

  waitForService<T>(
    key: ServiceKeyLike<T>,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    const name = serviceName(key)
    const existing = this.context.get(name)
    if (existing !== undefined) return Promise.resolve(existing as T)
    if (this.#state === 'stopping' || this.#state === 'stopped') {
      return Promise.reject(
        new Error(
          `Cannot wait for service '${name}' because the kernel is '${this.#state}'`,
        ),
      )
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let unsubscribe: () => void = () => undefined
      const settle = (error?: Error, value?: T): void => {
        if (settled) return
        settled = true
        this.#waiters.delete(waiter)
        unsubscribe()
        if (timer !== undefined) clearTimeout(timer)
        if (error !== undefined) reject(error)
        else resolve(value as T)
      }
      const waiter: ServiceWaiter = {
        fail: (error) => settle(error),
      }
      this.#waiters.add(waiter)
      unsubscribe = this.context.on('internal/service', (changed: string) => {
        if (changed !== name) return
        const value = this.context.get(name)
        if (value !== undefined) settle(undefined, value as T)
      })
      if (options?.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          settle(new Error(`Timed out waiting for service '${name}'`))
        }, options.timeoutMs)
      }
    })
  }

  createTaskScope(taskId: string): TaskScope {
    if (this.#state !== 'started') {
      throw new Error(
        `Kernel must be started before creating a task scope (current state: '${this.#state}')`,
      )
    }
    if (this.#taskScopes.has(taskId)) {
      throw new Error(`Task scope '${taskId}' already exists`)
    }
    const scope = forkTaskScope(this.context, taskId, this.#bus, (id) => {
      this.#handleTaskScopeDisposed(id)
    })
    this.#taskScopes.set(taskId, scope)
    this.#events.emit('task-scope-created', { taskId })
    return scope
  }

  getTaskScope(taskId: string): TaskScope | undefined {
    return this.#taskScopes.get(taskId)
  }

  async disposeTaskScope(taskId: string): Promise<boolean> {
    const scope = this.#taskScopes.get(taskId)
    if (!scope) return false
    await scope.dispose()
    return true
  }

  use(plugin: Plugin, config?: unknown): PluginHandle {
    this.#assertMutable('Cannot mount a plugin')
    const scope = this.context.plugin(
      plugin as Plugin.Function<Context>,
      config,
    )
    const handle = new CordisPluginHandle(
      this.#nextPluginId(pluginLabel(plugin)),
      scope,
      {
        onDisposed: (id) => this.#handlePluginDisposed(id),
        onQuarantined: (id, error) => this.#handlePluginQuarantined(id, error),
      },
    )
    this.#plugins.set(handle.id, handle)
    this.#events.emit('plugin-mounted', { id: handle.id })
    return handle
  }

  useBeeAgentPlugin(
    plugin: LifecycleBeeAgentPlugin,
    options: BeeAgentPluginMountOptions = {},
  ): BeeAgentPluginHandle {
    this.#assertMutable('Cannot mount a Bee Agent plugin')
    const manifestId = plugin.manifest.id
    for (const entry of this.#quarantine.values()) {
      if (entry.pluginId !== manifestId) continue
      throw new Error(
        `Plugin '${manifestId}' is quarantined after a failed unload and requires a kernel restart before it can be mounted again`,
      )
    }
    const controller = prepareBeeAgentPluginMount(plugin, options)
    const scope = this.context.plugin(controller.plugin, {})
    const handle = new CordisBeeAgentPluginHandle(
      this.#nextPluginId(manifestId),
      scope,
      plugin,
      controller,
      {
        onDisposed: (id) => this.#handlePluginDisposed(id),
        onQuarantined: (id, error) =>
          this.#handlePluginQuarantined(id, error, manifestId),
      },
      options.replacementTier ?? 'a',
    )
    this.#plugins.set(handle.id, handle)
    this.#events.emit('plugin-mounted', { id: handle.id })
    return handle
  }

  #setState(to: KernelState): void {
    const from = this.#state
    if (from === to) return
    this.#state = to
    this.#events.emit('state-changed', { from, to })
  }

  #assertMutable(action: string): void {
    if (this.#state === 'stopping' || this.#state === 'stopped') {
      throw new Error(`${action} while the kernel is '${this.#state}'`)
    }
  }

  #failWaiters(error: Error): void {
    for (const waiter of [...this.#waiters]) {
      waiter.fail(error)
    }
  }

  #handleTaskScopeDisposed(taskId: string): void {
    const scope = this.#taskScopes.get(taskId)
    if (!scope) return
    this.#taskScopes.delete(taskId)
    scope.markDisposed()
    this.#events.emit('task-scope-disposed', { taskId })
  }

  #handlePluginDisposed(id: string): void {
    if (this.#plugins.delete(id)) {
      this.#events.emit('plugin-unmounted', { id })
    }
  }

  #handlePluginQuarantined(
    id: string,
    error: unknown,
    pluginId?: string,
  ): void {
    this.#quarantine.set(id, { id, pluginId, error })
    this.#events.emit('plugin-quarantined', { id, pluginId, error })
  }

  #nextPluginId(label: string): string {
    const clean = label.replaceAll(/[^a-zA-Z0-9-_]/g, '') || 'plugin'
    let id = `${clean}-${++this.#pluginCounter}`
    while (this.#plugins.has(id)) {
      id = `${clean}-${++this.#pluginCounter}`
    }
    return id
  }
}

function pluginLabel(plugin: Plugin): string {
  if (typeof plugin === 'function') return plugin.name || 'plugin'
  if (typeof plugin === 'object' && plugin !== null) {
    const object = plugin as Plugin.Object<Context>
    if (typeof object.apply === 'function' && object.apply.name) {
      return object.apply.name
    }
  }
  return 'plugin'
}

export function createKernel(config: KernelConfig = {}): Kernel {
  return new Kernel(config)
}
