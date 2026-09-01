import { describe, expect, it } from 'vitest'
import {
  ChronicleSchemaRegistry,
  registerMemoryChronicleEvents,
  registerStructureChronicleEvents,
} from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import { registerThreadChronicleEvents } from '@bee-agent/thread'
import { registerRuntimeChronicleEvents } from '@bee-agent/runtime'
import { createFakeLlmRuntime } from '@bee-agent/runtime/testing'
import { createMemoryKanbanStore } from '@bee-agent/kanban/testing'
import { registerKanbanChronicleEvents } from '@bee-agent/kanban'
import { EmbeddedMemoryProvider } from '@bee-agent/memory-bee'
import { buildBeeServer } from '../src/index.ts'
import type { BeeServer } from '../src/index.ts'

interface TrajectoryEntryDto {
  readonly eventId: string
  readonly streamId: string
  readonly sequence: number
  readonly eventTime: string
  readonly eventType: string
  readonly loop: 'fast' | 'slow'
  readonly category: string
  readonly summary: string
}

interface TrajectoryPageDto {
  readonly entries: readonly TrajectoryEntryDto[]
  readonly counts: {
    readonly fast: number
    readonly slow: number
    readonly byCategory: Record<string, number>
  }
  readonly scannedStreams: number
}

/**
 * The global trajectory timeline (architecture §7.4): one turn produces both
 * loops' facts — thread/model events on the fast side, the derived memory
 * claim on the slow side — and /trajectory makes every one of them visible,
 * classified, and filterable without touching the streams themselves.
 */
describe('host trajectory timeline', () => {
  it('classifies a real turn into fast and slow loops with filterable categories', async () => {
    const registry = new ChronicleSchemaRegistry()
    registerStructureChronicleEvents(registry)
    registerThreadChronicleEvents(registry)
    registerRuntimeChronicleEvents(registry)
    registerMemoryChronicleEvents(registry)
    const store = new MemoryChronicleStore(registry)
    const server: BeeServer = await buildBeeServer({
      store,
      kanban: createMemoryKanbanStore(
        (() => {
          const kanbanRegistry = new ChronicleSchemaRegistry()
          registerKanbanChronicleEvents(kanbanRegistry)
          return kanbanRegistry
        })(),
      ),
      llm: createFakeLlmRuntime({
        script: [{ type: 'respond', deltas: ['Understood.'] }],
      }),
      memory: new EmbeddedMemoryProvider({ store }),
      logger: false,
    })
    await server.app.listen({ host: '127.0.0.1', port: 0 })
    await server.app.ready()
    const address = server.app.server.address()
    const baseUrl = `http://127.0.0.1:${address !== null && typeof address === 'object' ? address.port : 0}`

    try {
      const threadResponse = await fetch(`${baseUrl}/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'trajectory test' }),
      })
      expect(threadResponse.status).toBe(201)
      const thread = (await threadResponse.json()) as { id: string }

      const turnResponse = await fetch(
        `${baseUrl}/threads/${thread.id}/turns`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            input: 'From now on, always answer in Portuguese.',
          }),
        },
      )
      expect(turnResponse.status).toBe(200)
      expect(((await turnResponse.json()) as { status: string }).status).toBe(
        'completed',
      )

      const page = (await (
        await fetch(`${baseUrl}/trajectory`)
      ).json()) as TrajectoryPageDto
      expect(page.counts.fast).toBeGreaterThan(0)
      expect(page.counts.slow).toBeGreaterThan(0)
      expect(page.counts.byCategory.input).toBeGreaterThan(0)
      expect(page.counts.byCategory.llm).toBeGreaterThan(0)
      expect(page.counts.byCategory.memory).toBeGreaterThan(0)

      const fast = (
        (await (
          await fetch(`${baseUrl}/trajectory?loop=fast`)
        ).json()) as TrajectoryPageDto
      ).entries
      expect(fast.length).toBeGreaterThan(0)
      for (const entry of fast) expect(entry.loop).toBe('fast')
      expect(
        fast.some(
          (entry) =>
            entry.category === 'input' && entry.summary.includes('Portuguese'),
        ),
      ).toBe(true)
      expect(fast.some((entry) => entry.category === 'llm')).toBe(true)

      const slow = (
        (await (
          await fetch(`${baseUrl}/trajectory?loop=slow`)
        ).json()) as TrajectoryPageDto
      ).entries
      expect(slow.length).toBeGreaterThan(0)
      for (const entry of slow) expect(entry.loop).toBe('slow')
      expect(
        slow.some(
          (entry) =>
            entry.category === 'memory' &&
            entry.eventType === 'memory.claim.recorded',
        ),
      ).toBe(true)

      const inputsOnly = (
        (await (
          await fetch(`${baseUrl}/trajectory?category=input`)
        ).json()) as TrajectoryPageDto
      ).entries
      expect(inputsOnly.length).toBeGreaterThan(0)
      for (const entry of inputsOnly) expect(entry.category).toBe('input')

      const bounded = (
        (await (
          await fetch(`${baseUrl}/trajectory?limit=3`)
        ).json()) as TrajectoryPageDto
      ).entries
      expect(bounded.length).toBeLessThanOrEqual(3)

      const times = page.entries.map((entry) => entry.eventTime)
      const sorted = [...times].sort((a, b) => (a < b ? 1 : -1))
      expect(times).toEqual(sorted)
    } finally {
      await server.app.close()
    }
  })
})
