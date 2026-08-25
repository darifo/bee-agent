import type { Context, ForkScope } from 'cordis'
import type { ReplacementTier } from './replacement.ts'
import type {
  PluginDrainReport,
  PluginHandle,
  PluginHandleStatus,
  PluginHealthReport,
} from './types.ts'

export interface PluginHandleCallbacks {
  onDisposed(id: string): void
  onQuarantined(id: string, error: unknown): void
}

/**
 * Runs a drain task under an optional timeout. A timed-out drain resolves
 * with `timedOut: true` (an expected operational outcome, reported rather
 * than thrown); a failed drain rejects, and the losing side of the race is
 * always observed so its rejection is never unhandled.
 */
export function drainWithTimeout(
  task: Promise<PluginDrainReport>,
  timeoutMs: number | undefined,
): Promise<PluginDrainReport> {
  if (timeoutMs === undefined) return task
  return new Promise<PluginDrainReport>((resolve, reject) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
    task.then(
      (report) => {
        clearTimeout(timer)
        resolve(report)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export class CordisPluginHandle implements PluginHandle {
  readonly id: string
  readonly context: Context
  readonly #scope: ForkScope<Context>
  readonly #callbacks: PluginHandleCallbacks
  readonly #ready: Promise<void>
  #status: PluginHandleStatus = 'mounted'
  #quarantineError: unknown

  constructor(
    id: string,
    scope: ForkScope<Context>,
    callbacks: PluginHandleCallbacks,
  ) {
    this.id = id
    this.#scope = scope
    this.context = scope.ctx
    this.#callbacks = callbacks
    this.#ready = Promise.resolve()
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

  get replacementTier(): ReplacementTier {
    return 'a'
  }

  get ready(): Promise<void> {
    return this.#ready
  }

  async dispose(): Promise<void> {
    if (this.#status !== 'mounted') return
    try {
      this.#scope.dispose()
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

  async drain(): Promise<PluginDrainReport> {
    // Plain cordis plugins hold only reversible effects, released by cordis
    // on dispose; there is no in-flight work to wait for.
    return { timedOut: false }
  }

  async healthCheck(): Promise<PluginHealthReport> {
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
