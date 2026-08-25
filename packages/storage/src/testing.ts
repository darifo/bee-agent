import type { ExpectStatic, SuiteAPI, TestAPI } from 'vitest'
import type { EventStore } from '@bee-agent/event-store'
import type { TransactionManager } from './index.ts'

/**
 * The consumer's vitest test APIs, injected at registration time. The suite
 * never imports `vitest` itself: a shared utility package cannot reliably
 * resolve the exact module instance the consumer's test runner uses, and a
 * second instance silently loses the suite context. Only types are
 * referenced, so nothing from vitest leaks into the built output.
 */
export interface EventStoreContractHarness {
  readonly describe: SuiteAPI
  readonly it: TestAPI
  readonly expect: ExpectStatic
}

/**
 * What a dialect adapter hands to {@link defineEventStoreContractSuite}.
 * `transactions` is required so the suite can exercise rollback semantics
 * through the public contract.
 */
export interface EventStoreContractSubject {
  readonly store: EventStore
  readonly transactions: TransactionManager
}

export interface EventStoreContractSetup<
  C extends EventStoreContractSubject = EventStoreContractSubject,
> {
  /** Describe-block label shown in test output. */
  readonly name: string
  /** Creates a migrated, isolated subject; `destroy` disposes it. */
  create(): Promise<C>
  destroy(subject: C): Promise<void> | void
}

async function withSubject<C extends EventStoreContractSubject>(
  setup: EventStoreContractSetup<C>,
  run: (subject: C) => Promise<void>,
): Promise<void> {
  const subject = await setup.create()
  try {
    await run(subject)
  } finally {
    await setup.destroy(subject)
  }
}

async function collect(
  store: EventStore,
  taskId: string,
  afterSequence?: number,
): Promise<readonly string[]> {
  const types: string[] = []
  for await (const event of store.readTask(taskId, afterSequence)) {
    types.push(`${event.sequence}:${event.type}`)
  }
  return types
}

/**
 * The dialect-agnostic EventStore + TransactionManager contract suite from
 * ADR 0004. Both storage adapters run it unchanged; dialect-specific
 * behaviour (persistence across reopen, driver quirks) stays in the plugin.
 */
export function defineEventStoreContractSuite<
  C extends EventStoreContractSubject,
>(harness: EventStoreContractHarness, setup: EventStoreContractSetup<C>): void {
  const { describe, it, expect } = harness
  describe(setup.name, () => {
    it('persists and replays events in sequence order', () =>
      withSubject(setup, async ({ store }) => {
        const taskId = crypto.randomUUID()
        const created = await store.appendBatch([
          { taskId, type: 'task.created', payload: { input: '1 + 1' } },
          { taskId, type: 'task.completed', payload: { result: 2 } },
        ])

        expect(created.map((event) => event.sequence)).toEqual([1, 2])
        expect(created[0]?.id).toEqual(expect.any(String))
        expect(created[0]?.createdAt).toEqual(expect.any(String))
        expect(await collect(store, taskId)).toEqual([
          '1:task.created',
          '2:task.completed',
        ])
        expect(await store.getLatestSequence(taskId)).toBe(2)
      }))

    it('allocates unique contiguous sequences for concurrent appends', () =>
      withSubject(setup, async ({ store }) => {
        const taskId = crypto.randomUUID()
        const events = await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            store.append({ taskId, type: 'test.event', payload: { index } }),
          ),
        )

        expect(
          events.map((event) => event.sequence).sort((a, b) => a - b),
        ).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
      }))

    it('replays only events after a checkpoint sequence', () =>
      withSubject(setup, async ({ store }) => {
        const taskId = crypto.randomUUID()
        await store.appendBatch([
          { taskId, type: 'event.1', payload: {} },
          { taskId, type: 'event.2', payload: {} },
          { taskId, type: 'event.3', payload: {} },
        ])

        expect(await collect(store, taskId, 2)).toEqual(['3:event.3'])
      }))

    it('returns nothing for unknown tasks', () =>
      withSubject(setup, async ({ store }) => {
        const taskId = crypto.randomUUID()
        expect(await collect(store, taskId)).toEqual([])
        expect(await store.getLatestSequence(taskId)).toBe(0)
      }))

    it('treats empty batches as no-ops', () =>
      withSubject(setup, async ({ store }) => {
        await expect(store.appendBatch([])).resolves.toEqual([])
      }))

    it('rejects invalid events without consuming a sequence', () =>
      withSubject(setup, async ({ store }) => {
        const taskId = crypto.randomUUID()
        await expect(
          store.append({
            taskId: 'not-a-uuid',
            type: 'test.event',
            payload: {},
          }),
        ).rejects.toThrow()
        await expect(
          store.append({ taskId, type: '', payload: {} }),
        ).rejects.toThrow()

        const first = await store.append({
          taskId,
          type: 'test.event',
          payload: {},
        })
        expect(first.sequence).toBe(1)
      }))

    it('lists task ids oldest first', () =>
      withSubject(setup, async ({ store }) => {
        const oldest = crypto.randomUUID()
        const newest = crypto.randomUUID()
        await store.append({ taskId: oldest, type: 'a', payload: {} })
        await store.append({ taskId: newest, type: 'b', payload: {} })

        expect(await store.listTaskIds()).toEqual([oldest, newest])
      }))

    it('rolls back events appended inside a failed transaction', () =>
      withSubject(setup, async ({ store, transactions }) => {
        const taskId = crypto.randomUUID()
        await expect(
          transactions.transaction(async () => {
            await store.append({ taskId, type: 'test.event', payload: {} })
            throw new Error('abort')
          }),
        ).rejects.toThrow('abort')

        expect(await store.getLatestSequence(taskId)).toBe(0)
        expect(await collect(store, taskId)).toEqual([])
      }))
  })
}
