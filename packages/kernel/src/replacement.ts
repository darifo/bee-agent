/**
 * Tiered hot replacement (architecture §9.3): plugins declare how safely
 * they can be replaced, and a coordinator enforces the boundaries — A-tier
 * swaps only with no call in flight, B-tier defers to the Turn boundary
 * (drain + checkpoint + rebind), and C-tier refuses to pretend it is a
 * zero-downtime swap. A Turn in progress pins its StructureVersion so a
 * replacement never changes the structure an executing Turn was built on.
 */

export const REPLACEMENT_TIERS = ['a', 'b', 'c'] as const
export type ReplacementTier = (typeof REPLACEMENT_TIERS)[number]

/** A requested replacement: what to swap, its tier, and how to do it. */
export interface ReplacementRequest<T> {
  readonly tier: ReplacementTier
  /** Stable identity of the plugin being replaced (its manifest id). */
  readonly key: string
  /** B-tier quiesce hook: stop taking new calls, wait for in-flight work. */
  readonly drain?: (() => Promise<void>) | undefined
  /** Unmount the old plugin and mount the replacement. */
  readonly apply: () => Promise<T>
}

export type ReplacementOutcome<T> =
  | { readonly kind: 'applied'; readonly value: T }
  | { readonly kind: 'deferred' }
  | { readonly kind: 'restart-required' }

export class ReplacementCoordinator {
  #inTurn = false
  #structureVersion: string | undefined
  #pending: ReplacementRequest<unknown>[] = []
  #appliedKeys: string[] = []

  /** True while a Turn is executing and replacements must not apply. */
  get inTurn(): boolean {
    return this.#inTurn
  }

  /** The structure version pinned by the current Turn, if any. */
  get structureVersion(): string | undefined {
    return this.#structureVersion
  }

  /** Keys of every replacement applied so far (oldest first). */
  get appliedKeys(): readonly string[] {
    return this.#appliedKeys
  }

  /** Number of B-tier replacements deferred to the Turn boundary. */
  get pendingCount(): number {
    return this.#pending.length
  }

  /** Enters a Turn, pinning the structure it runs under. */
  beginTurn(structureVersion: string): void {
    if (this.#inTurn) {
      throw new Error('A Turn is already executing')
    }
    this.#inTurn = true
    this.#structureVersion = structureVersion
  }

  /**
   * Ends the current Turn and applies every deferred B-tier replacement in
   * order: drain first, then swap. The pinned structure version is cleared
   * so the next Turn can adopt the new structure.
   */
  async endTurn(): Promise<void> {
    if (!this.#inTurn) return
    const pending = this.#pending.splice(0)
    this.#inTurn = false
    this.#structureVersion = undefined
    for (const request of pending) {
      if (request.drain !== undefined) await request.drain()
      const value = await request.apply()
      void value
      this.#appliedKeys.push(request.key)
    }
  }

  /**
   * Requests a replacement. A-tier applies only with no Turn in flight
   * (throwing otherwise — an A-tier plugin must not swap mid-call); B-tier
   * drains then applies now, or defers to `endTurn` when a Turn is running;
   * C-tier always reports restart-required without applying.
   */
  async replace<T>(
    request: ReplacementRequest<T>,
  ): Promise<ReplacementOutcome<T>> {
    switch (request.tier) {
      case 'a':
        if (this.#inTurn) {
          throw new Error(
            `A-tier replacement '${request.key}' is not allowed while a Turn is executing`,
          )
        }
        return { kind: 'applied', value: await this.#apply(request) }
      case 'b':
        if (this.#inTurn) {
          this.#pending.push(request)
          return { kind: 'deferred' }
        }
        if (request.drain !== undefined) await request.drain()
        return { kind: 'applied', value: await this.#apply(request) }
      case 'c':
        return { kind: 'restart-required' }
    }
  }

  async #apply<T>(request: ReplacementRequest<T>): Promise<T> {
    const value = await request.apply()
    this.#appliedKeys.push(request.key)
    return value
  }
}
