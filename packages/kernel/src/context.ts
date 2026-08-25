/**
 * A minimal Cordis-style context (own implementation, no `cordis` package).
 *
 * This reproduces only the surface the kernel actually uses — service slots,
 * event listeners, reversible effects, plugin forking, service isolation,
 * and start/stop — with the same semantics cordis provides for them. The
 * heavyweight cordis features (traceable service proxies, `inject`
 * dependency resolution, reactive config, service mixins/aliases) are
 * deliberately out of scope: the kernel never used them.
 *
 * Service slots live on the root context under a name (ordinary services) or
 * a symbol (isolated services), so a forked context resolves a service by
 * walking up its parent chain and isolation with a shared realm resolves to
 * the same symbol slot.
 */

export type Disposer = () => void | Promise<void>

export interface ForkScope<C = Context> {
  readonly ctx: C
  dispose(): void
  update(config: unknown): void
}

export type PluginFunction<C = Context> = (
  ctx: C,
  config: unknown,
) => void | Promise<void>

export type PluginObject<C = Context> = {
  apply(ctx: C, config: unknown): void | Promise<void>
  reusable?: boolean
}

export type Plugin<C = Context> = PluginFunction<C> | PluginObject<C>

export type PluginLike = PluginFunction | PluginObject

type ServiceKey = string | symbol

export class Context {
  readonly #parent: Context | undefined
  readonly #root: Context
  readonly #services = new Map<ServiceKey, unknown>()
  readonly #isolatedKeys = new Map<string, ServiceKey>()
  // Event listeners are deliberately untyped: an event's payload shape is
  // the emitter/listener pair's contract, not the context's.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly #events = new Map<string, Set<(...args: any[]) => void>>()
  readonly #effects: Disposer[] = []
  readonly #tasks: Promise<unknown>[] = []
  #config: Record<string, unknown>
  #baseDir: string | undefined
  #disposed = false

  constructor(config: Record<string, unknown> = {}, parent?: Context) {
    this.#parent = parent
    this.#root = parent?.root ?? this
    this.#config = config
  }

  get root(): Context {
    return this.#root
  }

  get config(): Record<string, unknown> {
    return this.#config
  }

  get baseDir(): string | undefined {
    return this.#baseDir ?? this.#parent?.baseDir
  }

  set baseDir(value: string) {
    this.#baseDir = value
  }

  /** Resolves a service, walking the parent chain. */
  get(name: string): unknown {
    const key = this.#isolatedKeys.get(name) ?? name
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let cursor: Context | undefined = this
    while (cursor !== undefined) {
      if (cursor.#services.has(key)) return cursor.#services.get(key)
      cursor = cursor.#parent
    }
    return undefined
  }

  /**
   * Registers a service on the root store under its slot key. Returns a
   * disposer that removes it; the disposer is also registered as an effect so
   * disposing the context that set it releases the slot automatically.
   */
  set(name: string, value: unknown): Disposer {
    this.#assertActive('set a service')
    const key = this.#isolatedKeys.get(name) ?? name
    if (this.#root.#services.has(key)) {
      throw new Error(`service ${name} has been registered`)
    }
    this.#root.#services.set(key, value)
    if (!this.#isolatedKeys.has(name)) {
      this.emit('internal/service', name)
    }
    let disposed = false
    const dispose: Disposer = () => {
      if (disposed) return
      disposed = true
      if (this.#root.#services.get(key) === value) {
        this.#root.#services.delete(key)
        if (!this.#isolatedKeys.has(name)) {
          this.emit('internal/service', name)
        }
      }
    }
    this.#effects.push(dispose)
    return () => {
      const index = this.#effects.indexOf(dispose)
      if (index >= 0) this.#effects.splice(index, 1)
      dispose()
    }
  }

  /** Registers an event listener; returns a disposer that removes it. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): Disposer {
    this.#assertActive('listen')
    let set = this.#events.get(event)
    if (set === undefined) {
      set = new Set()
      this.#events.set(event, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  /**
   * Dispatches an event to this context and every ancestor, so a forked
   * context's `internal/service` emission reaches the root's listeners.
   */
  emit(event: string, ...args: unknown[]): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let cursor: Context | undefined = this
    while (cursor !== undefined) {
      const listeners = cursor.#events.get(event)
      if (listeners !== undefined) {
        for (const listener of [...listeners]) {
          listener(...args)
        }
      }
      cursor = cursor.#parent
    }
  }

  /**
   * Registers a reversible effect: `callback` returns the disposer that
   * undoes it. Returns a function that removes the effect early.
   */
  effect(callback: () => Disposer): Disposer {
    this.#assertActive('create an effect')
    const disposer = callback()
    this.#effects.push(disposer)
    return () => {
      const index = this.#effects.indexOf(disposer)
      if (index >= 0) this.#effects.splice(index, 1)
    }
  }

  /**
   * Forks a child context and applies the plugin to it. Async plugin bodies
   * are tracked and awaited by {@link start}. Returns a scope that disposes
   * the fork and forwards config updates.
   */
  plugin(plugin: PluginLike, config: unknown = {}): ForkScope {
    this.#assertActive('mount a plugin')
    const child = new Context({}, this)
    const apply = typeof plugin === 'function' ? plugin : plugin.apply
    const result = apply(child, config)
    if (result instanceof Promise) {
      this.#tasks.push(result)
      // A rejected plugin body still tears the fork down (releasing its
      // effects, e.g. the stop-on-dispose hook), without failing start().
      this.#tasks.push(
        result.then(
          () => undefined,
          () => {
            child.dispose()
          },
        ),
      )
    }
    return {
      ctx: child,
      dispose: () => child.dispose(),
      update: (nextConfig) => {
        child.#config = nextConfig as Record<string, unknown>
      },
    }
  }

  /**
   * Returns a child context that isolates `name`: its set/get of that service
   * use a private slot. Contexts sharing the same `realm` share one slot.
   */
  isolate(name: string, realm?: symbol): Context {
    const child = new Context({}, this)
    child.#isolatedKeys.set(name, realm ?? Symbol(name))
    return child
  }

  /**
   * Awaits every async plugin body mounted so far. A plugin whose startup
   * rejects does not fail the kernel start: its own ready promise carries the
   * error (matching cordis, where async plugin bodies run under `ensure`).
   */
  async start(): Promise<void> {
    const tasks = this.#tasks.splice(0)
    await Promise.allSettled(tasks)
  }

  /** Stops the context: releases effects in reverse registration order. */
  async stop(): Promise<void> {
    this.dispose()
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    const effects = this.#effects.splice(0).reverse()
    for (const effect of effects) {
      void effect()
    }
    this.emit('dispose')
  }

  #assertActive(action: string): void {
    if (this.#disposed) {
      throw new Error(`cannot ${action} on a disposed context`)
    }
  }
}
