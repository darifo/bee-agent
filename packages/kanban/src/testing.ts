import type { ExpectStatic, SuiteAPI, TestAPI } from 'vitest'
import type { ChronicleSchemaRegistry } from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import {
  ChronicleKanbanStore,
  KanbanLeaseLostError,
  KanbanTaskNotFoundError,
} from './store.ts'
import type { KanbanStore } from './store.ts'
import {
  KanbanInvalidTransitionError,
  KanbanVersionConflictError,
} from './state-machine.ts'
import type { KanbanTaskId } from './protocol.ts'

/**
 * Test harness for the Kanban store. The vitest APIs are injected by the
 * consumer so the suite never resolves a second vitest instance (same
 * convention as `@bee-agent/knowledge`'s Chronicle suite).
 */
export interface KanbanStoreContractHarness {
  readonly describe: SuiteAPI
  readonly it: TestAPI
  readonly expect: ExpectStatic
}

export interface KanbanStoreContractSubject {
  readonly store: KanbanStore
}

export interface KanbanStoreContractSetup<
  C extends KanbanStoreContractSubject = KanbanStoreContractSubject,
> {
  readonly name: string
  create(): Promise<C>
  destroy(subject: C): Promise<void> | void
}

/**
 * The in-memory Kanban store — the default harness for unit tests and the
 * contract suite. Backed by `MemoryChronicleStore`, so it is dialect-free
 * and needs no database.
 */
export function createMemoryKanbanStore(
  registry: ChronicleSchemaRegistry,
): KanbanStore {
  return new ChronicleKanbanStore(new MemoryChronicleStore(registry))
}

const NOW = '2026-08-25T10:00:00.000Z'
const LATER = '2026-08-25T11:00:00.000Z'
const LATER2 = '2026-08-25T12:00:00.000Z'
const LEASE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_LEASE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

async function withSubject<C extends KanbanStoreContractSubject>(
  setup: KanbanStoreContractSetup<C>,
  run: (subject: C) => Promise<void>,
): Promise<void> {
  const subject = await setup.create()
  try {
    await run(subject)
  } finally {
    await setup.destroy(subject)
  }
}

/** Moves a freshly created task through inbox → triaged → ready. */
async function moveToReady(
  store: KanbanStore,
  taskId: KanbanTaskId,
  fromVersion: number,
): Promise<void> {
  await store.transition(taskId, {
    to: 'triaged',
    expectedVersion: fromVersion,
    at: LATER,
  })
  await store.transition(taskId, {
    to: 'ready',
    expectedVersion: fromVersion + 1,
    at: LATER,
  })
}

/**
 * The dialect-agnostic KanbanStore contract suite (v1 refactor plan §5.2
 * P2-2): create/idempotency, expected-version transitions, claim/lease,
 * list ordering, and rebuild-from-log recovery.
 */
export function defineKanbanStoreContractSuite<
  C extends KanbanStoreContractSubject,
>(
  harness: KanbanStoreContractHarness,
  setup: KanbanStoreContractSetup<C>,
): void {
  const { describe, it, expect } = harness
  describe(setup.name, () => {
    it('creates and reads a task at version 1', () =>
      withSubject(setup, async ({ store }) => {
        const task = await store.create({ title: 'Write docs', now: NOW })
        expect(task.status).toBe('inbox')
        expect(task.version).toBe(1)
        expect(await store.get(task.id)).toEqual(task)
      }))

    it('deduplicates creates sharing an idempotency key', () =>
      withSubject(setup, async ({ store }) => {
        const init = { title: 'Idempotent', idempotencyKey: 'key-1', now: NOW }
        const first = await store.create(init)
        const second = await store.create(init)
        expect(second.id).toBe(first.id)
        const matches = (await store.list()).filter(
          (task) => task.idempotencyKey === 'key-1',
        )
        expect(matches).toHaveLength(1)
      }))

    it('applies a transition and bumps the version', () =>
      withSubject(setup, async ({ store }) => {
        const task = await store.create({ title: 'Triage', now: NOW })
        const triaged = await store.transition(task.id, {
          to: 'triaged',
          expectedVersion: 1,
          at: LATER,
        })
        expect(triaged.status).toBe('triaged')
        expect(triaged.version).toBe(2)
        expect(await store.get(task.id)).toEqual(triaged)
      }))

    it('rejects a stale expected version without writing', () =>
      withSubject(setup, async ({ store }) => {
        const task = await store.create({ title: 'Race', now: NOW })
        await expect(
          store.transition(task.id, {
            to: 'triaged',
            expectedVersion: 2,
            at: LATER,
          }),
        ).rejects.toBeInstanceOf(KanbanVersionConflictError)
        expect((await store.get(task.id))?.version).toBe(1)
      }))

    it('rejects illegal transitions', () =>
      withSubject(setup, async ({ store }) => {
        const task = await store.create({ title: 'Illegal', now: NOW })
        await expect(
          store.transition(task.id, {
            to: 'done',
            expectedVersion: 1,
            at: LATER,
          }),
        ).rejects.toBeInstanceOf(KanbanInvalidTransitionError)
      }))

    it('throws not-found for a missing task', () =>
      withSubject(setup, async ({ store }) => {
        await expect(
          store.transition(crypto.randomUUID(), {
            to: 'triaged',
            expectedVersion: 1,
            at: LATER,
          }),
        ).rejects.toBeInstanceOf(KanbanTaskNotFoundError)
      }))

    it('claims into running with a lease and releases back to ready', () =>
      withSubject(setup, async ({ store }) => {
        const task = await store.create({ title: 'Claim', now: NOW })
        await moveToReady(store, task.id, 1)
        const claimed = await store.transition(task.id, {
          to: 'running',
          expectedVersion: 3,
          at: LATER,
          claim: {
            claimant: 'worker-1',
            leaseId: LEASE_ID,
            claimedAt: LATER,
            expiresAt: LATER2,
          },
        })
        expect(claimed.status).toBe('running')
        expect(claimed.claim?.leaseId).toBe(LEASE_ID)

        const released = await store.transition(task.id, {
          to: 'ready',
          expectedVersion: 4,
          at: LATER2,
        })
        expect(released.status).toBe('ready')
        expect(released.claim).toBeUndefined()
      }))

    it('renews a lease, bumps the version, and fences a stale lease id', () =>
      withSubject(setup, async ({ store }) => {
        const task = await store.create({ title: 'Heartbeat', now: NOW })
        await moveToReady(store, task.id, 1)
        await store.transition(task.id, {
          to: 'running',
          expectedVersion: 3,
          at: LATER,
          claim: {
            claimant: 'worker-1',
            leaseId: LEASE_ID,
            claimedAt: LATER,
            expiresAt: LATER,
          },
        })

        const renewed = await store.renewLease(task.id, {
          leaseId: LEASE_ID,
          expiresAt: LATER2,
        })
        expect(renewed.claim?.expiresAt).toBe(LATER2)
        expect(renewed.version).toBe(5)

        await expect(
          store.renewLease(task.id, {
            leaseId: OTHER_LEASE_ID,
            expiresAt: LATER2,
          }),
        ).rejects.toBeInstanceOf(KanbanLeaseLostError)
      }))

    it('lists by status in priority order', () =>
      withSubject(setup, async ({ store }) => {
        const low = await store.create({
          title: 'low',
          priority: 'low',
          now: NOW,
        })
        const high = await store.create({
          title: 'high',
          priority: 'high',
          now: NOW,
        })
        await moveToReady(store, low.id, 1)
        await moveToReady(store, high.id, 1)

        const ready = await store.list({ status: 'ready' })
        expect(ready.map((task) => task.title)).toEqual(['high', 'low'])
      }))

    it('rebuilds the projection from the event log', () =>
      withSubject(setup, async ({ store }) => {
        const task = await store.create({ title: 'Rebuild', now: NOW })
        await moveToReady(store, task.id, 1)
        await store.rebuild()

        const rebuilt = await store.get(task.id)
        expect(rebuilt?.status).toBe('ready')
        expect(rebuilt?.version).toBe(3)
        expect(await store.list({ status: 'ready' })).toHaveLength(1)
      }))
  })
}
