import type { ChronicleEvent, NewChronicleEvent } from './envelope.js'

/**
 * The Chronicle stream store contract (v1 refactor plan §5.2 P1-6,
 * architecture §8.2). Sequences are contiguous from 1 per stream, appends
 * carry an expected sequence for optimistic concurrency, and a retry of an
 * already-stored append is an idempotent success, not a conflict.
 */

export class ChronicleSequenceConflictError extends Error {
  constructor(
    readonly streamId: string,
    readonly expectedSequence: number,
    readonly actualNextSequence: number,
  ) {
    super(
      `Chronicle stream '${streamId}' expected next sequence ` +
        `${expectedSequence} but the next free sequence is ${actualNextSequence}`,
    )
    this.name = 'ChronicleSequenceConflictError'
  }
}

export interface ChronicleAppendOptions {
  /**
   * The sequence the first appended event must take. Must equal the stream's
   * current length + 1, or match an already-stored append (idempotent retry).
   */
  readonly expectedSequence: number
}

export interface ChronicleStore {
  /**
   * Appends events atomically: validates each event against the store's
   * registry, assigns `sequence` and `ingestTime`, and returns the stored
   * events. Retrying the same batch (same event ids, same expected sequence)
   * returns the stored events without writing again; anything else at that
   * position is a {@link ChronicleSequenceConflictError}.
   */
  append(
    streamId: string,
    events: readonly NewChronicleEvent[],
    options: ChronicleAppendOptions,
  ): Promise<readonly ChronicleEvent[]>

  /** Streams stored events with `sequence > afterSequence` in order. */
  readStream(
    streamId: string,
    afterSequence?: number,
  ): AsyncIterable<ChronicleEvent>

  /** Current stream length; 0 for unknown streams. */
  getLatestSequence(streamId: string): Promise<number>

  /** All stream ids, oldest stream first. */
  listStreams(): Promise<readonly string[]>

  close(): Promise<void>
}
