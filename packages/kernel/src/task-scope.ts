import type { Context, ForkScope } from 'cordis'
import { EffectScope } from './effects.js'
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
  readonly effects = new EffectScope()
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

  /**
   * Marks the scope as disposed without running cordis teardown. Used when
   * cordis itself tore the fork down (kernel root shutdown): the registered
   * effects are released best-effort because this path is synchronous.
   */
  markDisposed(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#eventsBus?.dispose()
    void this.effects.release()
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#eventsBus?.dispose()
    const { failures } = await this.effects.release()
    this.#scope.dispose()
    if (failures.length === 1) throw failures[0]?.error
    if (failures.length > 1) {
      throw new AggregateError(
        failures.map((failure) => failure.error),
        `Task scope '${this.id}' dispose encountered errors`,
      )
    }
  }

  onDispose(callback: () => void | Promise<void>): () => void {
    if (this.#disposed) {
      throw new Error(`Task scope '${this.id}' is already disposed`)
    }
    return this.effects.add(callback)
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
