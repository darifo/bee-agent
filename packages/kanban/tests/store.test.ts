import { describe, expect, it } from 'vitest'
import {
  ChronicleSchemaRegistry,
  ChronicleSequenceConflictError,
} from '@bee-agent/knowledge'
import { registerKanbanChronicleEvents } from '../src/index.ts'
import {
  createMemoryKanbanStore,
  defineKanbanStoreContractSuite,
} from '../src/testing.ts'
import type { KanbanStoreContractSetup } from '../src/testing.ts'

const setup: KanbanStoreContractSetup = {
  name: 'MemoryKanbanStore (Kanban contract suite)',
  async create() {
    const registry = new ChronicleSchemaRegistry()
    registerKanbanChronicleEvents(registry)
    return { store: createMemoryKanbanStore(registry) }
  },
  destroy(subject) {
    return subject.store.close()
  },
}

defineKanbanStoreContractSuite({ describe, it, expect }, setup)

describe('MemoryKanbanStore concurrency', () => {
  it('lets exactly one of two concurrent claims win', async () => {
    const registry = new ChronicleSchemaRegistry()
    registerKanbanChronicleEvents(registry)
    const store = createMemoryKanbanStore(registry)

    const task = await store.create({ title: 'Contended', now: T })
    await store.transition(task.id, {
      to: 'triaged',
      expectedVersion: 1,
      at: T,
    })
    await store.transition(task.id, { to: 'ready', expectedVersion: 2, at: T })

    const claim = (worker: string) =>
      store.transition(task.id, {
        to: 'running',
        expectedVersion: 3,
        at: T,
        claim: {
          claimant: worker,
          leaseId: crypto.randomUUID(),
          claimedAt: T,
          expiresAt: T,
        },
      })

    const results = await Promise.allSettled([claim('w1'), claim('w2')])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toBeInstanceOf(ChronicleSequenceConflictError)

    const final = await store.get(task.id)
    expect(final?.status).toBe('running')
    expect(final?.version).toBe(4)
    expect(final?.claim?.claimant).toMatch(/^w[12]$/)
  })
})

const T = '2026-08-25T10:00:00.000Z'
