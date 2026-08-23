import { Context } from 'cordis'
import type { ForkScope } from 'cordis'

export interface KernelConfig {
  baseDir?: string
}

export interface TaskScope {
  readonly id: string
  readonly context: Context
  readonly disposed: boolean
  dispose(): void
}

function taskScopePlugin(context: Context, _config: { taskId: string }): void {
  void _config
  context.effect(() => () => undefined)
}
taskScopePlugin.reusable = true

class CordisTaskScope implements TaskScope {
  readonly id: string
  readonly context: Context
  readonly #scope: ForkScope<Context>
  #disposed = false

  constructor(taskId: string, scope: ForkScope<Context>) {
    this.id = taskId
    this.#scope = scope
    this.context = scope.ctx
  }

  get disposed(): boolean {
    return this.#disposed
  }

  dispose(): void {
    if (this.#disposed) return
    this.#scope.dispose()
    this.#disposed = true
  }
}

export class Kernel {
  readonly context: Context
  #started = false

  constructor(config: KernelConfig = {}) {
    this.context = new Context()
    if (config.baseDir) this.context.baseDir = config.baseDir
  }

  async start(): Promise<void> {
    if (this.#started) return
    await this.context.start()
    this.#started = true
  }

  async stop(): Promise<void> {
    if (!this.#started) return
    await this.context.stop()
    this.#started = false
  }

  registerService<T>(name: string, service: T): () => void {
    return this.context.set(name, service)
  }

  createTaskScope(taskId: string): TaskScope {
    if (!this.#started)
      throw new Error('Kernel must be started before creating a task scope')
    const scope = this.context.plugin(taskScopePlugin, { taskId })
    return new CordisTaskScope(taskId, scope)
  }
}

export function createKernel(config: KernelConfig = {}): Kernel {
  return new Kernel(config)
}

export { Context }
export type { Plugin } from 'cordis'
