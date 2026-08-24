import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ChronicleSchemaRegistry,
  newChronicleEvent,
} from '@bee-agent/knowledge'
import type { ChronicleStore } from '@bee-agent/knowledge'
import { defineChronicleStoreContractSuite } from '@bee-agent/knowledge/testing'
import type { ChronicleContractSetup } from '@bee-agent/knowledge/testing'
import { SQLiteChronicleStore } from '../src/index.js'

const setup: ChronicleContractSetup = {
  name: 'SQLiteChronicleStore (Chronicle contract suite)',
  async create() {
    const registry = new ChronicleSchemaRegistry()
    const store: ChronicleStore = new SQLiteChronicleStore({
      registry,
      filename: ':memory:',
    })
    return { store, registry }
  },
  destroy(subject) {
    return subject.store.close()
  },
}

defineChronicleStoreContractSuite({ describe, it, expect }, setup)

describe('SQLiteChronicleStore (dialect specifics)', () => {
  it('persists streams across database reopen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bee-chronicle-'))
    const filename = join(dir, 'chronicle.sqlite')
    try {
      const registry = new ChronicleSchemaRegistry()
      registry.register('reopen.seen', { payload: z.unknown() })

      const first = new SQLiteChronicleStore({ registry, filename })
      await first.append(
        'stream-1',
        [
          newChronicleEvent({
            eventType: 'reopen.seen',
            payload: { hello: 'chronicle' },
            actor: { type: 'system', id: 'test' },
          }),
        ],
        { expectedSequence: 1 },
      )
      await first.close()

      const reopened = new SQLiteChronicleStore({ registry, filename })
      expect(await reopened.getLatestSequence('stream-1')).toBe(1)
      const replayed: string[] = []
      for await (const event of reopened.readStream('stream-1')) {
        replayed.push(`${event.sequence}:${event.eventType}`)
      }
      expect(replayed).toEqual(['1:reopen.seen'])

      // Appends continue from the recovered tail.
      await reopened.append(
        'stream-1',
        [
          newChronicleEvent({
            eventType: 'reopen.seen',
            payload: { again: true },
            actor: { type: 'system', id: 'test' },
          }),
        ],
        { expectedSequence: 2 },
      )
      expect(await reopened.getLatestSequence('stream-1')).toBe(2)
      await reopened.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('shares a database handle and never closes it on close()', async () => {
    const registry = new ChronicleSchemaRegistry()
    registry.register('shared.seen', { payload: z.unknown() })
    const database = new Database(':memory:')
    const writer = new SQLiteChronicleStore({ registry, database })
    const reader = new SQLiteChronicleStore({ registry, database })

    await writer.append(
      'stream-shared',
      [
        newChronicleEvent({
          eventType: 'shared.seen',
          payload: {},
          actor: { type: 'system', id: 'test' },
        }),
      ],
      { expectedSequence: 1 },
    )
    await writer.close()
    expect(await reader.getLatestSequence('stream-shared')).toBe(1)
    await reader.close()
    database.close()
  })
})
