import type { Context, ForkScope } from 'cordis'
import type { EventBus, EventBusChild } from './events.js'
import type { TaskScope } from './types.js'

interface TaskScopePluginConfig {
  taskId: string
  onDisposed(taskId: string): void
}

function taskScopePlugin(
  context: Context,
  config: TaskScopePluginConfig,
): void {
  context.on('dispose', () => config.onDisposed(config.taskId))
}
taskScopePlugin.reusable = true

export class CordisTaskScope implements TaskScope {
  readonly id: string
  readonly #scope: ForkScope<Context>
  readonly #bus: EventBus
  #ctx: Context
  #eventsBus: EventBusChild | undefined
  #disposed = false

  constructor(taskId: string, scope: ForkScope<Context>, bus: EventBus) {
    this.id = taskId
    this.#scope = scope
    this.#bus = bus
    this.#ctx = scope.ctx
  }

  get context(): Context {
    return this.#ctx
  }

  get disposed(): boolean {
    return this.#disposed
  }

  get events(): EventBusChild {
    if (this.#disposed) {
      throw new Error(`Task scope '${this.id}' is already disposed`)
    }
    this.#eventsBus ??= this.#bus.createChild()
    return this.#eventsBus
  }

  /** Marks the scope as disposed without running cordis teardown. */
  markDisposed(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#eventsBus?.dispose()
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#eventsBus?.dispose()
    this.#scope.dispose()
  }

  onDispose(callback: () => void | Promise<void>): () => void {
    if (this.#disposed) {
      throw new Error(`Task scope '${this.id}' is already disposed`)
    }
    return this.context.on('dispose', callback)
  }

  isolateService(name: string, realm?: symbol): void {
    if (this.#disposed) {
      throw new Error(`Task scope '${this.id}' is already disposed`)
    }
    this.#ctx = this.#ctx.isolate(name, realm)
  }
}

export function forkTaskScope(
  context: Context,
  taskId: string,
  bus: EventBus,
  onDisposed: (taskId: string) => void,
): CordisTaskScope {
  const scope = context.plugin(taskScopePlugin, { taskId, onDisposed })
  return new CordisTaskScope(taskId, scope, bus)
}
