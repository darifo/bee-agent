import type { ChronicleEvent } from '@bee-agent/knowledge'
import type {
  WorldModelStore,
  WorldProjectionInput,
  WorldProjector,
} from '@bee-agent/knowledge'
import type {
  ChronicleAppendBroadcast,
  BroadcastingChronicleStore,
} from './broadcasting-store.ts'

/**
 * Keeps the WorldModel in step with the Chronicle (v1 refactor plan §5.5
 * WF4-D): at start it replays every existing stream the projectors consume
 * (catch-up across restarts), then it projects live appends as they
 * broadcast. Projection failures never fail the source append — they surface
 * through {@link WorldProjectionService.inspect} and remain detectable on
 * the next rebuild's digest verification.
 */

export interface WorldProjectionServiceOptions {
  readonly store: BroadcastingChronicleStore
  readonly world: WorldModelStore
  readonly projectors: readonly WorldProjector[]
}

export interface WorldProjectionStatus {
  readonly started: boolean
  readonly projectedEvents: number
  readonly lastError: string | null
}

export class WorldProjectionService {
  readonly #store: BroadcastingChronicleStore
  readonly #world: WorldModelStore
  readonly #projectors: readonly WorldProjector[]
  #started = false
  #projectedEvents = 0
  #lastError: string | null = null
  #unsubscribe: (() => void) | undefined
  #tail: Promise<unknown> = Promise.resolve()

  constructor(options: WorldProjectionServiceOptions) {
    this.#store = options.store
    this.#world = options.world
    this.#projectors = options.projectors
  }

  async start(): Promise<void> {
    if (this.#started) return
    this.#started = true

    // Catch-up: replay every existing stream the projectors consume, in one
    // deterministic batch so the resulting digest matches a cold rebuild.
    const inputs: WorldProjectionInput[] = []
    for (const streamId of await this.#store.listStreams()) {
      if (!this.#projectors.some((projector) => projector.wants(streamId))) {
        continue
      }
      for await (const event of this.#store.readStream(streamId)) {
        const projection = this.#projectOne(event)
        if (projection !== undefined) inputs.push(projection)
      }
    }
    await this.#recordNow(inputs)

    // Live: project appended events as they broadcast.
    const handler = (broadcast: ChronicleAppendBroadcast) => {
      if (!this.#started) return
      if (!this.#projectors.some((p) => p.wants(broadcast.streamId))) return
      const live = broadcast.events
        .map((event) => this.#projectOne(event))
        .filter((projection) => projection !== undefined)
      if (live.length > 0) this.#enqueue(live)
    }
    this.#store.appended.on('append', handler)
    this.#unsubscribe = () => {
      this.#store.appended.off('append', handler)
    }
  }

  stop(): void {
    this.#started = false
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
  }

  inspect(): WorldProjectionStatus {
    return {
      started: this.#started,
      projectedEvents: this.#projectedEvents,
      lastError: this.#lastError,
    }
  }

  /** Resolves once every queued projection has settled. */
  settled(): Promise<void> {
    return this.#tail.then(
      () => undefined,
      () => undefined,
    )
  }

  #projectOne(event: ChronicleEvent): WorldProjectionInput | undefined {
    let merged: WorldProjectionInput | undefined
    for (const projector of this.#projectors) {
      if (!projector.wants(event.streamId)) continue
      const projection = projector.project(event)
      if (projection === undefined) continue
      this.#projectedEvents += 1
      merged =
        merged === undefined ? projection : mergeInputs([merged, projection])
    }
    return merged
  }

  #enqueue(inputs: readonly WorldProjectionInput[]): void {
    if (inputs.length === 0) return
    const merged = mergeInputs(inputs)
    this.#tail = this.#tail.then(
      async () => {
        try {
          await this.#world.record(merged)
          this.#lastError = null
        } catch (error) {
          this.#lastError =
            error instanceof Error ? error.message : String(error)
        }
      },
      async () => {
        this.#lastError = 'a previous world projection failed'
      },
    )
  }

  async #recordNow(inputs: readonly WorldProjectionInput[]): Promise<void> {
    this.#enqueue(inputs)
    await this.settled()
  }
}

/** Merges projection inputs into one record call, preserving order. */
function mergeInputs(
  inputs: readonly WorldProjectionInput[],
): WorldProjectionInput {
  const entities = []
  const relations = []
  for (const input of inputs) {
    entities.push(...(input.entities ?? []))
    relations.push(...(input.relations ?? []))
  }
  return { entities, relations }
}
