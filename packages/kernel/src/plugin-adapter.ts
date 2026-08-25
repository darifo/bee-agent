import type { Context, ForkScope, Plugin } from 'cordis'
import { drainWithTimeout } from './plugin-handle.ts'
import type { PluginHandleCallbacks } from './plugin-handle.ts'
import type { ReplacementTier } from './replacement.ts'
import type {
  BeeAgentPluginHandle,
  BeeAgentPluginMountOptions,
  LifecycleBeeAgentPlugin,
  PluginDrainOptions,
  PluginDrainReport,
  PluginHandleStatus,
  PluginHealthReport,
} from './types.ts'

/**
 * Shared mutable state between the cordis plugin body and the handle returned
 * by {@link Kernel.useBeeAgentPlugin}.
 */
export interface BeeAgentPluginMountController {
  readonly plugin: Plugin.Function<Context>
  readonly ready: Promise<void>
  /** Idempotent `plugin.stop()`; at most one stop is ever issued. */
  requestStop(): Promise<void>
}

export function prepareBeeAgentPluginMount(
  plugin: LifecycleBeeAgentPlugin,
  options: BeeAgentPluginMountOptions,
): BeeAgentPluginMountController {
  let resolveReady!: () => void
  let rejectReady!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  let stopTask: Promise<void> | undefined
  const requestStop = (): Promise<void> => {
    stopTask ??= Promise.resolve(plugin.stop())
    return stopTask
  }

  const mount = (context: Context): Promise<void> => {
    const task = (async () => {
      await plugin.start()
      const services =
        typeof options.services === 'function'
          ? options.services(plugin)
          : options.services
      for (const [name, value] of Object.entries(services ?? {})) {
        if (value === undefined) continue
        context.set(name, value)
      }
    })()
    // Safety net for teardowns triggered outside the handle (kernel shutdown).
    context.effect(() => () => {
      void requestStop()
    })
    task.then(
      () => resolveReady(),
      (error) => rejectReady(error),
    )
    // Returning the task lets cordis track it during `context.start()` flush
    // and cancel the scope when the Bee Agent plugin fails to start.
    return task
  }
  mount.reusable = false

  return { plugin: mount, ready, requestStop }
}

export class CordisBeeAgentPluginHandle implements BeeAgentPluginHandle {
  readonly id: string
  readonly context: Context
  readonly plugin: LifecycleBeeAgentPlugin
  readonly #scope: ForkScope<Context>
  readonly #controller: BeeAgentPluginMountController
  readonly #callbacks: PluginHandleCallbacks
  readonly #replacementTier: ReplacementTier
  #status: PluginHandleStatus = 'mounted'
  #quarantineError: unknown

  constructor(
    id: string,
    scope: ForkScope<Context>,
    plugin: LifecycleBeeAgentPlugin,
    controller: BeeAgentPluginMountController,
    callbacks: PluginHandleCallbacks,
    replacementTier: ReplacementTier = 'a',
  ) {
    this.id = id
    this.#scope = scope
    this.context = scope.ctx
    this.plugin = plugin
    this.#controller = controller
    this.#callbacks = callbacks
    this.#replacementTier = replacementTier
  }

  get replacementTier(): ReplacementTier {
    return this.#replacementTier
  }

  get disposed(): boolean {
    return this.#status === 'disposed'
  }

  get status(): PluginHandleStatus {
    return this.#status
  }

  get quarantineError(): unknown {
    return this.#quarantineError
  }

  get ready(): Promise<void> {
    return this.#controller.ready
  }

  async dispose(): Promise<void> {
    // A quarantined plugin is never retried or force-cleaned: it keeps its
    // state until the whole kernel restarts.
    if (this.#status !== 'mounted') return
    try {
      this.#scope.dispose()
    } catch (error) {
      this.#quarantine(error)
      throw error
    }
    try {
      await this.#controller.requestStop()
    } catch (error) {
      this.#quarantine(error)
      throw error
    }
    this.#status = 'disposed'
    this.#callbacks.onDisposed(this.id)
  }

  update(config: unknown): void {
    this.#scope.update(config)
  }

  async drain(options?: PluginDrainOptions): Promise<PluginDrainReport> {
    if (typeof this.plugin.drain !== 'function') return { timedOut: false }
    return drainWithTimeout(
      Promise.resolve(this.plugin.drain(options)),
      options?.timeoutMs,
    )
  }

  async healthCheck(): Promise<PluginHealthReport> {
    if (typeof this.plugin.healthCheck === 'function') {
      return this.plugin.healthCheck()
    }
    if (this.#status === 'quarantined') {
      return { status: 'unhealthy', detail: 'plugin is quarantined' }
    }
    return { status: 'healthy' }
  }

  #quarantine(error: unknown): void {
    this.#status = 'quarantined'
    this.#quarantineError = error
    this.#callbacks.onQuarantined(this.id, error)
  }
}
