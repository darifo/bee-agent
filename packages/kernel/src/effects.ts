/**
 * A cleanup callback registered on an {@link EffectScope}. Disposers may be
 * synchronous or asynchronous; release always awaits them.
 */
export type EffectDisposer = () => void | Promise<void>

export interface EffectAddOptions {
  /** Diagnostic label surfaced in release failure reports. */
  readonly label?: string
}

export interface EffectReleaseFailure {
  readonly label?: string | undefined
  readonly error: unknown
}

export interface EffectReleaseResult {
  /** Number of disposers that ran without throwing. */
  readonly released: number
  /** Every failure encountered; remaining disposers still ran. */
  readonly failures: readonly EffectReleaseFailure[]
}

interface EffectEntry {
  readonly label: string | undefined
  readonly dispose: EffectDisposer
}

/**
 * The kernel's formal reversible-effect registry: disposers are registered
 * with {@link add} and released in reverse registration order (LIFO), so an
 * effect can always undo what earlier effects set up. Release never stops at
 * the first failure — every remaining disposer still runs and each failure is
 * collected into the returned report.
 */
export class EffectScope {
  readonly #entries: EffectEntry[] = []
  #releaseTask: Promise<EffectReleaseResult> | undefined

  /** Number of currently registered disposers. */
  get size(): number {
    return this.#entries.length
  }

  /** True once release started; further registrations are rejected. */
  get released(): boolean {
    return this.#releaseTask !== undefined
  }

  /**
   * Registers a disposer and returns a function that unregisters it again
   * (idempotent). Throws once the scope is releasing or released — effects
   * cannot sneak onto a scope that is being torn down.
   */
  add(disposer: EffectDisposer, options: EffectAddOptions = {}): () => void {
    if (this.released) {
      throw new Error('Cannot add an effect to an already released scope')
    }
    const entry: EffectEntry = { label: options.label, dispose: disposer }
    this.#entries.push(entry)
    return () => {
      const index = this.#entries.indexOf(entry)
      if (index >= 0) this.#entries.splice(index, 1)
    }
  }

  /**
   * Releases every registered disposer in reverse registration order.
   * Idempotent and safe to call concurrently: one release runs, later calls
   * await the same result.
   */
  release(): Promise<EffectReleaseResult> {
    this.#releaseTask ??= this.#runRelease()
    return this.#releaseTask
  }

  async #runRelease(): Promise<EffectReleaseResult> {
    const failures: EffectReleaseFailure[] = []
    let released = 0
    while (this.#entries.length > 0) {
      const entry = this.#entries.pop() as EffectEntry
      try {
        await entry.dispose()
        released += 1
      } catch (error) {
        failures.push({ label: entry.label, error })
      }
    }
    return { released, failures }
  }
}
