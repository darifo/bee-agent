import type {
  ChronicleStore,
  MemoryClaim,
  MemoryContext,
  MemoryContextInput,
  MemoryConsolidationReport,
  MemoryDerivationInput,
  MemoryDerivationResult,
  MemoryExport,
  MemoryHealth,
  MemoryIngestInput,
  MemoryIngestResult,
  MemoryProvider,
  MemoryQuery,
  MemoryRepresentation,
  NewChronicleEvent,
} from '@bee-agent/knowledge'
import {
  ChronicleSequenceConflictError,
  MemoryProviderUnavailableError,
  memoryHealthChangedEvent,
  memoryStreamId,
} from '@bee-agent/knowledge'
import type { MemoryBridgeTransport } from './bridge-transport.ts'

/**
 * The remote memory provider (v1 refactor plan §5.5 WF4-C): wraps a bridge
 * transport with a consecutive-failure circuit breaker and explicit health
 * transitions. An outage is never a silent switch to empty memory — every
 * transition (healthy → degraded → unavailable, and recovery) is a durable
 * `memory.health.changed` fact in the local Chronicle, and calls fail fast
 * with {@link MemoryProviderUnavailableError} once the circuit opens. The
 * breaker recovers through `health()` probes: callers that check health (the
 * recall hook does) reopen the circuit when the transport answers again.
 */

export interface RemoteMemoryOptions {
  readonly transport: MemoryBridgeTransport
  /** Local Chronicle for durable health transitions; omitted = no persistence. */
  readonly store?: ChronicleStore | undefined
  /** Consecutive transport failures before the circuit opens. Default 3. */
  readonly failureThreshold?: number | undefined
}

type BreakerStatus = MemoryHealth['status']

export class RemoteMemoryProvider implements MemoryProvider {
  readonly #transport: MemoryBridgeTransport
  readonly #store: ChronicleStore | undefined
  readonly #failureThreshold: number
  #consecutiveFailures = 0
  #published: BreakerStatus = 'healthy'
  #tail: Promise<unknown> = Promise.resolve()

  constructor(options: RemoteMemoryOptions) {
    this.#transport = options.transport
    this.#store = options.store
    this.#failureThreshold = options.failureThreshold ?? 3
    if (this.#failureThreshold < 1) {
      throw new Error('failureThreshold must be at least 1')
    }
  }

  ingest(input: MemoryIngestInput): Promise<MemoryIngestResult> {
    return this.#call('ingest', () => this.#transport.ingest(input))
  }

  query(query: MemoryQuery): Promise<readonly MemoryClaim[]> {
    return this.#call('query', () => this.#transport.query(query))
  }

  buildContext(input: MemoryContextInput): Promise<MemoryContext> {
    return this.#call('buildContext', () => this.#transport.buildContext(input))
  }

  getRepresentation(
    claimIds: readonly string[],
  ): Promise<MemoryRepresentation> {
    return this.#call('getRepresentation', () =>
      this.#transport.getRepresentation(claimIds),
    )
  }

  derive(input: MemoryDerivationInput): Promise<MemoryDerivationResult> {
    return this.#call('derive', () => this.#transport.derive(input))
  }

  consolidate(): Promise<MemoryConsolidationReport> {
    return this.#call('consolidate', () => this.#transport.consolidate())
  }

  retract(claimId: string, reason?: string): Promise<MemoryClaim> {
    return this.#call('retract', () => this.#transport.retract(claimId, reason))
  }

  export(): Promise<MemoryExport> {
    return this.#call('export', () => this.#transport.export())
  }

  /**
   * Breaker status combined with the transport's own view. A degraded breaker
   * reports its local view (recent failures) without another transport call;
   * an open circuit turns this into the recovery probe — one successful
   * transport health call closes the circuit again.
   */
  async health(): Promise<MemoryHealth> {
    const breaker = this.#breakerStatus()
    if (breaker === 'unavailable') {
      try {
        const probed = await this.#transport.health()
        this.#onSuccess()
        return probed
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          status: 'unavailable',
          detail: `circuit open; probe failed: ${message}`,
        }
      }
    }
    if (breaker === 'degraded') {
      return {
        status: 'degraded',
        detail: `${this.#consecutiveFailures} recent transport failure(s)`,
      }
    }
    try {
      return await this.#transport.health()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { status: 'degraded', detail: `health probe failed: ${message}` }
    }
  }

  /** Resolves once every queued health-event append has settled. */
  settled(): Promise<void> {
    return this.#tail.then(
      () => undefined,
      () => undefined,
    )
  }

  // -----------------------------------------------------------------------
  // Breaker internals
  // -----------------------------------------------------------------------

  #breakerStatus(): BreakerStatus {
    if (this.#consecutiveFailures >= this.#failureThreshold) {
      return 'unavailable'
    }
    return this.#consecutiveFailures === 0 ? 'healthy' : 'degraded'
  }

  async #call<T>(operation: string, run: () => Promise<T>): Promise<T> {
    if (this.#breakerStatus() === 'unavailable') {
      throw new MemoryProviderUnavailableError(
        `circuit open after ${this.#consecutiveFailures} consecutive '${operation}' failures`,
      )
    }
    try {
      const result = await run()
      this.#onSuccess()
      return result
    } catch (error) {
      if (error instanceof MemoryProviderUnavailableError) throw error
      // Every transport failure is an availability fact at this boundary:
      // surface it as the breaker's error (with the cause in the detail) so
      // callers can treat remote outages uniformly — local provider bugs
      // elsewhere still propagate untouched.
      this.#onFailure(error, operation)
      const message = error instanceof Error ? error.message : String(error)
      throw new MemoryProviderUnavailableError(
        `'${operation}' failed (${this.#consecutiveFailures}/${this.#failureThreshold}): ${message}`,
      )
    }
  }

  #onSuccess(): void {
    if (this.#consecutiveFailures === 0) return
    this.#consecutiveFailures = 0
    this.#publish('healthy')
  }

  #onFailure(error: unknown, operation: string): void {
    this.#consecutiveFailures += 1
    const status = this.#breakerStatus()
    const message = error instanceof Error ? error.message : String(error)
    const detail = `'${operation}' failed (${this.#consecutiveFailures}/${this.#failureThreshold}): ${message}`
    this.#publish(status, detail)
  }

  /** Appends a durable transition event once per status change. */
  #publish(status: BreakerStatus, detail?: string): void {
    if (status === this.#published) return
    const from = this.#published
    this.#published = status
    if (this.#store === undefined) return
    const event = memoryHealthChangedEvent({
      from,
      to: status,
      ...(detail === undefined ? {} : { detail }),
    })
    this.#tail = this.#tail.then(
      () => this.#append(event),
      () => this.#append(event),
    )
  }

  async #append(event: NewChronicleEvent): Promise<void> {
    const store = this.#store
    if (store === undefined) return
    for (let attempt = 0; ; attempt += 1) {
      const expected = (await store.getLatestSequence(memoryStreamId())) + 1
      try {
        await store.append(memoryStreamId(), [event], {
          expectedSequence: expected,
        })
        return
      } catch (error) {
        if (error instanceof ChronicleSequenceConflictError && attempt < 2) {
          continue
        }
        // Health events must never mask the caller's outcome: a failed
        // append is swallowed here (the transition already happened).
        return
      }
    }
  }
}
