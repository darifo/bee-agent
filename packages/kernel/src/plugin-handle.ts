import type { Context, ForkScope } from 'cordis'
import type { PluginHandle } from './types.js'

export class CordisPluginHandle implements PluginHandle {
  readonly id: string
  readonly context: Context
  readonly #scope: ForkScope<Context>
  readonly #onDisposed: (id: string) => void
  readonly #ready: Promise<void>
  #disposed = false

  constructor(
    id: string,
    scope: ForkScope<Context>,
    onDisposed: (id: string) => void,
  ) {
    this.id = id
    this.#scope = scope
    this.context = scope.ctx
    this.#onDisposed = onDisposed
    this.#ready = Promise.resolve()
  }

  get disposed(): boolean {
    return this.#disposed
  }

  get ready(): Promise<void> {
    return this.#ready
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#scope.dispose()
    this.#onDisposed(this.id)
  }

  update(config: unknown): void {
    this.#scope.update(config)
  }
}
