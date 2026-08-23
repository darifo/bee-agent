import type { Context, ForkScope, Plugin } from 'cordis'
import type { BeeAgentPlugin } from '@bee-agent/plugin-sdk'
import type {
  BeeAgentPluginHandle,
  BeeAgentPluginMountOptions,
} from './types.js'

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
  plugin: BeeAgentPlugin,
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
  readonly plugin: BeeAgentPlugin
  readonly #scope: ForkScope<Context>
  readonly #controller: BeeAgentPluginMountController
  readonly #onDisposed: (id: string) => void
  #disposed = false

  constructor(
    id: string,
    scope: ForkScope<Context>,
    plugin: BeeAgentPlugin,
    controller: BeeAgentPluginMountController,
    onDisposed: (id: string) => void,
  ) {
    this.id = id
    this.#scope = scope
    this.context = scope.ctx
    this.plugin = plugin
    this.#controller = controller
    this.#onDisposed = onDisposed
  }

  get disposed(): boolean {
    return this.#disposed
  }

  get ready(): Promise<void> {
    return this.#controller.ready
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#scope.dispose()
    await this.#controller.requestStop()
    this.#onDisposed(this.id)
  }

  update(config: unknown): void {
    this.#scope.update(config)
  }
}
