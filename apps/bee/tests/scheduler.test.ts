import { describe, expect, it } from 'vitest'
import {
  ChronicleSchemaRegistry,
  registerMemoryChronicleEvents,
  registerStructureChronicleEvents,
  registerWorldChronicleEvents,
} from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import {
  readThreadEvents,
  registerThreadChronicleEvents,
} from '@bee-agent/thread'
import { registerRuntimeChronicleEvents } from '@bee-agent/runtime'
import { createFakeLlmRuntime } from '@bee-agent/runtime/testing'
import { registerKanbanChronicleEvents } from '@bee-agent/kanban'
import { createMemoryKanbanStore } from '@bee-agent/kanban/testing'
import { buildBeeServer } from '../src/index.ts'
import type { BeeServer } from '../src/index.ts'

function createRegistryStore(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerStructureChronicleEvents(registry)
  registerThreadChronicleEvents(registry)
  registerRuntimeChronicleEvents(registry)
  registerMemoryChronicleEvents(registry)
  registerWorldChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

describe('host scheduler', () => {
  it('fires a due trigger as a schedule-turn on the bound thread', async () => {
    const server: BeeServer = await buildBeeServer({
      store: createRegistryStore(),
      kanban: (() => {
        const registry = new ChronicleSchemaRegistry()
        registerKanbanChronicleEvents(registry)
        return createMemoryKanbanStore(registry)
      })(),
      llm: createFakeLlmRuntime({
        script: [{ type: 'respond', deltas: ['Report ready.'] }],
      }),
      // Enabled without an auto-tick: the test drives firing manually.
      scheduler: {},
      logger: false,
    })
    await server.app.listen({ host: '127.0.0.1', port: 0 })
    await server.app.ready()
    const baseUrl = `http://127.0.0.1:${
      (server.app.server.address() as { port: number }).port
    }`

    try {
      const threadResponse = await fetch(`${baseUrl}/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'scheduled work' }),
      })
      const thread = (await threadResponse.json()) as { id: string }

      // A one-shot trigger due one second ago.
      const registerResponse = await fetch(`${baseUrl}/scheduler/triggers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input: 'Write the status report.',
          threadId: thread.id,
          at: new Date(Date.now() - 1_000).toISOString(),
        }),
      })
      expect(registerResponse.status).toBe(201)
      const { trigger } = (await registerResponse.json()) as {
        trigger: { id: string; nextRunAt: string }
      }

      const tickResponse = await fetch(`${baseUrl}/scheduler/tick`, {
        method: 'POST',
      })
      const tick = (await tickResponse.json()) as {
        fired: { status: string; missedIntervals: number; turnId: string }[]
      }
      expect(tick.fired).toHaveLength(1)
      expect(tick.fired[0]).toMatchObject({
        status: 'completed',
        missedIntervals: 0,
      })

      // The bound thread now carries a schedule-triggered turn.
      const page = await readThreadEvents(server.store, thread.id)
      const scheduledTurn = page.events.find(
        (
          event,
        ): event is Extract<
          (typeof page.events)[number],
          { event: 'turn.started' }
        > =>
          event.event === 'turn.started' && event.turn.trigger === 'schedule',
      )
      expect(scheduledTurn?.turn.input).toBe('Write the status report.')

      // The one-shot trigger is exhausted; removing it is durable.
      const listResponse = await fetch(`${baseUrl}/scheduler/triggers`)
      const { triggers } = (await listResponse.json()) as {
        triggers: { id: string; nextRunAt?: string }[]
      }
      expect(triggers).toHaveLength(1)
      expect(triggers[0]!.nextRunAt).toBeUndefined()

      const removeResponse = await fetch(
        `${baseUrl}/scheduler/triggers/${trigger.id}`,
        { method: 'DELETE' },
      )
      expect(removeResponse.status).toBe(200)
      const repeatResponse = await fetch(
        `${baseUrl}/scheduler/triggers/${trigger.id}`,
        { method: 'DELETE' },
      )
      expect(repeatResponse.status).toBe(404)
    } finally {
      await server.app.close()
    }
  })
})
