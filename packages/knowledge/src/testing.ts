import type { ExpectStatic, SuiteAPI, TestAPI } from 'vitest'
import { z } from 'zod'
import type { ChronicleEvent, NewChronicleEvent } from './envelope.ts'
import { newChronicleEvent } from './envelope.ts'
import type {
  ChronicleAppendOptions,
  ChronicleStore,
} from './chronicle-store.ts'
import { ChronicleSequenceConflictError } from './chronicle-store.ts'
import type { ChronicleSchemaRegistry } from './registry.ts'

/**
 * Test harness for the Chronicle contract suite. The vitest APIs are injected
 * by the consumer so the suite never resolves a second vitest instance
 * (same convention as `@bee-agent/storage`'s EventStore suite).
 */
export interface ChronicleContractHarness {
  readonly describe: SuiteAPI
  readonly it: TestAPI
  readonly expect: ExpectStatic
}

export interface ChronicleContractSubject {
  readonly store: ChronicleStore
  readonly registry: ChronicleSchemaRegistry
}

export interface ChronicleContractSetup<
  C extends ChronicleContractSubject = ChronicleContractSubject,
> {
  /** Describe-block label shown in test output. */
  readonly name: string
  /** Creates an isolated subject; `destroy` disposes it. */
  create(): Promise<C>
  destroy(subject: C): Promise<void> | void
}

async function withSubject<C extends ChronicleContractSubject>(
  setup: ChronicleContractSetup<C>,
  run: (subject: C) => Promise<void>,
): Promise<void> {
  const subject = await setup.create()
  try {
    await run(subject)
  } finally {
    await setup.destroy(subject)
  }
}

const testActor = { type: 'system', id: 'test' } as const

/** Registers `eventType` (once) with an accepting schema and returns a producer. */
function typeFor(
  registry: ChronicleSchemaRegistry,
  eventType: string,
): (payload?: unknown) => NewChronicleEvent {
  if (!registry.has(eventType)) {
    registry.register(eventType, { payload: z.unknown() })
  }
  return (payload: unknown = {}) =>
    newChronicleEvent({ eventType, payload, actor: testActor })
}

async function collect(
  store: ChronicleStore,
  streamId: string,
  afterSequence?: number,
): Promise<string[]> {
  const entries: string[] = []
  for await (const event of store.readStream(streamId, afterSequence)) {
    entries.push(`${event.sequence}:${event.eventType}`)
  }
  return entries
}

/**
 * The dialect-agnostic ChronicleStore contract suite (v1 refactor plan §5.2
 * P1-6): sequence allocation, optimistic concurrency, idempotent retries,
 * registry enforcement, and pagination semantics.
 */
export function defineChronicleStoreContractSuite<
  C extends ChronicleContractSubject,
>(harness: ChronicleContractHarness, setup: ChronicleContractSetup<C>): void {
  const { describe, it, expect } = harness
  describe(setup.name, () => {
    it('assigns contiguous sequences from 1 and stamps ingestTime', () =>
      withSubject(setup, async ({ store, registry }) => {
        const streamId = crypto.randomUUID()
        const first = typeFor(registry, 'test.first')
        const second = typeFor(registry, 'test.second')
        const stored = await store.append(
          streamId,
          [first({ n: 1 }), second({ n: 2 })],
          { expectedSequence: 1 },
        )

        expect(stored.map((event) => event.sequence)).toEqual([1, 2])
        expect(stored.map((event) => event.streamId)).toEqual([
          streamId,
          streamId,
        ])
        expect(stored.map((event) => event.ingestTime)).toEqual([
          expect.any(String),
          expect.any(String),
        ])
        expect(await store.getLatestSequence(streamId)).toBe(2)
      }))

    it('replays stored events in order and honors afterSequence', () =>
      withSubject(setup, async ({ store, registry }) => {
        const streamId = crypto.randomUUID()
        const x = typeFor(registry, 'a.x')
        const y = typeFor(registry, 'a.y')
        const zed = typeFor(registry, 'a.z')
        await store.append(streamId, [x(), y(), zed()], {
          expectedSequence: 1,
        })

        expect(await collect(store, streamId)).toEqual([
          '1:a.x',
          '2:a.y',
          '3:a.z',
        ])
        expect(await collect(store, streamId, 2)).toEqual(['3:a.z'])
        expect(await collect(store, streamId, 3)).toEqual([])
      }))

    it('rejects conflicting expected sequences without writing', () =>
      withSubject(setup, async ({ store, registry }) => {
        const streamId = crypto.randomUUID()
        const x = typeFor(registry, 'b.x')
        const y = typeFor(registry, 'b.y')
        await store.append(streamId, [x()], { expectedSequence: 1 })

        await expect(
          store.append(streamId, [y()], { expectedSequence: 1 }),
        ).rejects.toBeInstanceOf(ChronicleSequenceConflictError)
        await expect(
          store.append(streamId, [y()], { expectedSequence: 3 }),
        ).rejects.toBeInstanceOf(ChronicleSequenceConflictError)
        expect(await store.getLatestSequence(streamId)).toBe(1)
        expect(await collect(store, streamId)).toEqual(['1:b.x'])
      }))

    it('treats a retried append with the same ids as idempotent', () =>
      withSubject(setup, async ({ store, registry }) => {
        const streamId = crypto.randomUUID()
        const x = typeFor(registry, 'c.x')
        const event = x({ attempt: 1 })
        const stored = await store.append(streamId, [event], {
          expectedSequence: 1,
        })

        const retried = await store.append(streamId, [event], {
          expectedSequence: 1,
        })
        expect(retried).toEqual(stored)
        expect(await store.getLatestSequence(streamId)).toBe(1)
      }))

    it('conflicts when a retry carries different event ids', () =>
      withSubject(setup, async ({ store, registry }) => {
        const streamId = crypto.randomUUID()
        const x = typeFor(registry, 'd.x')
        await store.append(streamId, [x()], { expectedSequence: 1 })

        await expect(
          store.append(streamId, [x()], { expectedSequence: 1 }),
        ).rejects.toBeInstanceOf(ChronicleSequenceConflictError)
      }))

    it('rejects unknown event types and invalid payloads before writing', () =>
      withSubject(setup, async ({ store, registry }) => {
        const streamId = crypto.randomUUID()
        registry.register('e.typed', { payload: z.object({ n: z.number() }) })

        await expect(
          store.append(
            streamId,
            [
              newChronicleEvent({
                eventType: 'e.unknown',
                payload: {},
                actor: testActor,
              }),
            ],
            { expectedSequence: 1 },
          ),
        ).rejects.toThrow(/Unknown Chronicle event type/)
        await expect(
          store.append(
            streamId,
            [
              newChronicleEvent({
                eventType: 'e.typed',
                payload: 42,
                actor: testActor,
              }),
            ],
            { expectedSequence: 1 },
          ),
        ).rejects.toThrow(/payload schema/)

        expect(await store.getLatestSequence(streamId)).toBe(0)
      }))

    it('returns empty reads and zero sequence for unknown streams', () =>
      withSubject(setup, async ({ store }) => {
        const streamId = crypto.randomUUID()
        expect(await collect(store, streamId)).toEqual([])
        expect(await store.getLatestSequence(streamId)).toBe(0)
      }))

    it('treats empty batches as no-ops', () =>
      withSubject(setup, async ({ store }) => {
        const streamId = crypto.randomUUID()
        await expect(
          store.append(streamId, [], { expectedSequence: 1 }),
        ).resolves.toEqual([])
        expect(await store.getLatestSequence(streamId)).toBe(0)
      }))

    it('lists streams oldest first', () =>
      withSubject(setup, async ({ store, registry }) => {
        const oldest = crypto.randomUUID()
        const newest = crypto.randomUUID()
        const a = typeFor(registry, 'f.a')
        const b = typeFor(registry, 'f.b')
        await store.append(oldest, [a()], { expectedSequence: 1 })
        await store.append(newest, [b()], { expectedSequence: 1 })

        expect(await store.listStreams()).toEqual([oldest, newest])
      }))
  })
}

/**
 * In-memory {@link ChronicleStore} — the default harness for the contract
 * suite and for unit tests that need a Chronicle without a database. Not a
 * production backend: the embedded SQLite adapter is the default store.
 */
export class MemoryChronicleStore implements ChronicleStore {
  readonly #registry: ChronicleSchemaRegistry
  readonly #streams = new Map<string, ChronicleEvent[]>()
  readonly #now: () => string

  constructor(
    registry: ChronicleSchemaRegistry,
    options: { now?: () => string } = {},
  ) {
    this.#registry = registry
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async append(
    streamId: string,
    events: readonly NewChronicleEvent[],
    options: ChronicleAppendOptions,
  ): Promise<readonly ChronicleEvent[]> {
    if (events.length === 0) return []
    for (const event of events) {
      this.#registry.validateNew(event)
    }
    const stream = this.#streams.get(streamId)
    const nextSequence = (stream?.length ?? 0) + 1
    if (options.expectedSequence < 1) {
      throw new ChronicleSequenceConflictError(
        streamId,
        options.expectedSequence,
        nextSequence,
      )
    }
    if (options.expectedSequence !== nextSequence) {
      const start = options.expectedSequence - 1
      const existing = stream?.slice(start, start + events.length) ?? []
      const idempotent =
        existing.length === events.length &&
        existing.every(
          (stored, index) => stored.eventId === events[index]?.eventId,
        )
      if (!idempotent) {
        throw new ChronicleSequenceConflictError(
          streamId,
          options.expectedSequence,
          nextSequence,
        )
      }
      return existing
    }

    const ingestTime = this.#now()
    const stored = events.map((event, index) => ({
      ...event,
      streamId,
      sequence: nextSequence + index,
      ingestTime,
    }))
    if (stream === undefined) {
      this.#streams.set(streamId, stored)
    } else {
      stream.push(...stored)
    }
    return stored
  }

  async *readStream(
    streamId: string,
    afterSequence = 0,
  ): AsyncIterable<ChronicleEvent> {
    const stream = this.#streams.get(streamId)
    if (stream === undefined) return
    for (const event of stream) {
      if (event.sequence > afterSequence) yield event
    }
  }

  async getLatestSequence(streamId: string): Promise<number> {
    return this.#streams.get(streamId)?.length ?? 0
  }

  async listStreams(): Promise<readonly string[]> {
    return [...this.#streams.keys()]
  }

  async close(): Promise<void> {
    this.#streams.clear()
  }
}
