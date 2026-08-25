import { EventEmitter } from 'node:events'
import type {
  ChronicleAppendOptions,
  ChronicleEvent,
  ChronicleStore,
  NewChronicleEvent,
} from '@bee-agent/knowledge'

export interface ChronicleAppendBroadcast {
  readonly streamId: string
  readonly events: readonly ChronicleEvent[]
}

/**
 * {@link ChronicleStore} decorator that emits every successful append to the
 * `appended` emitter, so hosts can stream live thread events (SSE) without
 * polling. The decorator is transparent otherwise: reads and lifecycle calls
 * delegate straight to the wrapped store.
 */
export class BroadcastingChronicleStore implements ChronicleStore {
  readonly #inner: ChronicleStore
  readonly appended = new EventEmitter()

  constructor(inner: ChronicleStore) {
    this.#inner = inner
  }

  async append(
    streamId: string,
    events: readonly NewChronicleEvent[],
    options: ChronicleAppendOptions,
  ): Promise<readonly ChronicleEvent[]> {
    const stored = await this.#inner.append(streamId, events, options)
    if (stored.length > 0) {
      const broadcast: ChronicleAppendBroadcast = { streamId, events: stored }
      this.appended.emit('append', broadcast)
    }
    return stored
  }

  readStream(
    streamId: string,
    afterSequence?: number,
  ): AsyncIterable<ChronicleEvent> {
    return this.#inner.readStream(streamId, afterSequence)
  }

  getLatestSequence(streamId: string): Promise<number> {
    return this.#inner.getLatestSequence(streamId)
  }

  listStreams(): Promise<readonly string[]> {
    return this.#inner.listStreams()
  }

  close(): Promise<void> {
    return this.#inner.close()
  }
}
