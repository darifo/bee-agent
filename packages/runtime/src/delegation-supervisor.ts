export interface DelegationLimits {
  readonly maxDepth: number
  readonly maxConcurrency: number
  readonly maxChildren: number
  readonly maxTokens: number
  readonly maxDurationMs: number
  readonly maxCostUsd: number
  readonly maxWorldActions: number
}

export interface DelegationUsage {
  readonly tokens: number
  readonly costUsd: number
  readonly worldActions: number
}

export interface DelegationRequest<TInput> {
  readonly id: string
  readonly parentEpisodeId: string
  readonly depth: number
  readonly input: TInput
}

export interface DelegationOutcome<TOutput> {
  readonly id: string
  readonly parentEpisodeId: string
  readonly childEpisodeId: string
  readonly trajectoryId: string
  readonly output: TOutput
  readonly usage: DelegationUsage
}

export class DelegationLimitError extends Error {
  constructor(readonly limit: keyof DelegationLimits) {
    super(`Delegation exceeded ${limit}`)
    this.name = 'DelegationLimitError'
  }
}

/** Episode-scoped bounded fan-out; persistent work remains Kanban-owned. */
export class DelegationSupervisor<TInput, TOutput> {
  readonly #limits: DelegationLimits
  readonly #execute: (
    request: DelegationRequest<TInput>,
    signal: AbortSignal,
  ) => Promise<DelegationOutcome<TOutput>>

  constructor(options: {
    readonly limits: DelegationLimits
    readonly execute: (
      request: DelegationRequest<TInput>,
      signal: AbortSignal,
    ) => Promise<DelegationOutcome<TOutput>>
  }) {
    for (const [key, value] of Object.entries(options.limits)) {
      if (!Number.isFinite(value) || value <= 0)
        throw new Error(`Delegation limit '${key}' must be positive`)
    }
    this.#limits = options.limits
    this.#execute = options.execute
  }

  async run(
    requests: readonly DelegationRequest<TInput>[],
    parentSignal?: AbortSignal,
  ): Promise<readonly DelegationOutcome<TOutput>[]> {
    if (requests.length > this.#limits.maxChildren)
      throw new DelegationLimitError('maxChildren')
    if (requests.some((request) => request.depth > this.#limits.maxDepth))
      throw new DelegationLimitError('maxDepth')
    if (new Set(requests.map((request) => request.id)).size !== requests.length)
      throw new Error('Delegation request ids must be unique')

    const controller = new AbortController()
    const abort = () => controller.abort(parentSignal?.reason)
    parentSignal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(
      () => controller.abort(new DelegationLimitError('maxDurationMs')),
      this.#limits.maxDurationMs,
    )
    timer.unref()
    let cursor = 0
    const results: DelegationOutcome<TOutput>[] = []
    let usage: DelegationUsage = { tokens: 0, costUsd: 0, worldActions: 0 }
    const worker = async () => {
      while (!controller.signal.aborted) {
        const index = cursor++
        const request = requests[index]
        if (request === undefined) return
        const outcome = await this.#execute(request, controller.signal)
        usage = {
          tokens: usage.tokens + outcome.usage.tokens,
          costUsd: usage.costUsd + outcome.usage.costUsd,
          worldActions: usage.worldActions + outcome.usage.worldActions,
        }
        const exceeded: (keyof DelegationLimits)[] = []
        if (usage.tokens > this.#limits.maxTokens) exceeded.push('maxTokens')
        if (usage.costUsd > this.#limits.maxCostUsd) exceeded.push('maxCostUsd')
        if (usage.worldActions > this.#limits.maxWorldActions)
          exceeded.push('maxWorldActions')
        if (exceeded[0] !== undefined) {
          const error = new DelegationLimitError(exceeded[0])
          controller.abort(error)
          throw error
        }
        results[index] = outcome
      }
      throw controller.signal.reason
    }

    try {
      await Promise.all(
        Array.from(
          { length: Math.min(requests.length, this.#limits.maxConcurrency) },
          worker,
        ),
      )
      return results
    } finally {
      clearTimeout(timer)
      parentSignal?.removeEventListener('abort', abort)
      controller.abort()
    }
  }
}
