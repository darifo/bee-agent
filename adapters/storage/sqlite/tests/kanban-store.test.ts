import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChronicleSchemaRegistry } from '@bee-agent/knowledge'
import { registerKanbanChronicleEvents } from '@bee-agent/kanban'
import { defineKanbanStoreContractSuite } from '@bee-agent/kanban/testing'
import type { KanbanStoreContractSetup } from '@bee-agent/kanban/testing'
import { SQLiteKanbanStore } from '../src/index.ts'

const setup: KanbanStoreContractSetup = {
  name: 'SQLiteKanbanStore (Kanban contract suite)',
  async create() {
    const registry = new ChronicleSchemaRegistry()
    registerKanbanChronicleEvents(registry)
    return { store: new SQLiteKanbanStore({ registry, filename: ':memory:' }) }
  },
  destroy(subject) {
    return subject.store.close()
  },
}

defineKanbanStoreContractSuite({ describe, it, expect }, setup)

const NOW = '2026-08-25T10:00:00.000Z'

describe('SQLiteKanbanStore (dialect specifics)', () => {
  it('recovers tasks across a database reopen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bee-kanban-'))
    const filename = join(dir, 'kanban.sqlite')
    try {
      const registry = new ChronicleSchemaRegistry()
      registerKanbanChronicleEvents(registry)

      const first = new SQLiteKanbanStore({ registry, filename })
      const task = await first.create({ title: 'Persisted', now: NOW })
      await first.transition(task.id, {
        to: 'triaged',
        expectedVersion: 1,
        at: NOW,
      })
      await first.transition(task.id, {
        to: 'ready',
        expectedVersion: 2,
        at: NOW,
      })
      await first.transition(task.id, {
        to: 'running',
        expectedVersion: 3,
        at: NOW,
        claim: {
          claimant: 'worker-1',
          leaseId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          claimedAt: NOW,
          expiresAt: NOW,
        },
      })
      await first.close()

      const reopened = new SQLiteKanbanStore({ registry, filename })
      await reopened.rebuild()
      const recovered = await reopened.get(task.id)
      expect(recovered?.status).toBe('running')
      expect(recovered?.version).toBe(4)
      expect(recovered?.claim?.claimant).toBe('worker-1')

      // Appends continue from the recovered tail.
      await reopened.transition(task.id, {
        to: 'done',
        expectedVersion: 4,
        at: NOW,
      })
      expect((await reopened.get(task.id))?.status).toBe('done')
      await reopened.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
