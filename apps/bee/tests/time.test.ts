import { describe, expect, it } from 'vitest'
import {
  ChronicleSchemaRegistry,
  registerStructureChronicleEvents,
} from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import { registerThreadChronicleEvents } from '@bee-agent/thread'
import { registerRuntimeChronicleEvents } from '@bee-agent/runtime'
import { registerKanbanChronicleEvents } from '@bee-agent/kanban'
import { createMemoryKanbanStore } from '@bee-agent/kanban/testing'
import { createFakeLlmRuntime } from '@bee-agent/runtime/testing'
import { buildBeeServer } from '../src/index.ts'
import type { BeeServer } from '../src/index.ts'

/**
 * Accurate time is built in: every model request carries the current
 * date-time as a late system message (UTC+8 by default), the time_now tool
 * is declared to the model and always allowed, and the request is fully
 * replayable with the injected time visible.
 */
describe('host time integration', () => {
  it('injects the current date-time into every model request and declares time_now', async () => {
    const registry = new ChronicleSchemaRegistry()
    registerStructureChronicleEvents(registry)
    registerThreadChronicleEvents(registry)
    registerRuntimeChronicleEvents(registry)
    const store = new MemoryChronicleStore(registry)
    const llm = createFakeLlmRuntime({
      script: [{ type: 'respond', deltas: ['现在时间已知。'] }],
    })
    const server: BeeServer = await buildBeeServer({
      store,
      kanban: createMemoryKanbanStore(
        (() => {
          const kanbanRegistry = new ChronicleSchemaRegistry()
          registerKanbanChronicleEvents(kanbanRegistry)
          return kanbanRegistry
        })(),
      ),
      llm,
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
        body: JSON.stringify({ title: 'time test' }),
      })
      const thread = (await threadResponse.json()) as { id: string }

      const turnResponse = await fetch(
        `${baseUrl}/threads/${thread.id}/turns`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: '现在几点？' }),
        },
      )
      expect(((await turnResponse.json()) as { status: string }).status).toBe(
        'completed',
      )

      // The injected time message is part of the model-visible bundle.
      const firstCall = llm.calls[0]!
      const injected = firstCall.bundle.messages.find(
        (message) =>
          message.role === 'system' &&
          message.content.includes('Current date-time'),
      )
      expect(injected?.content).toContain('Asia/Shanghai (UTC+8)')
      expect(injected?.content).toMatch(/- UTC: \d{4}-\d{2}-\d{2}T/)

      // time_now is declared to the model as an always-allowed tool.
      expect(firstCall.bundle.tools.map((tool) => tool.id)).toContain(
        'time_now',
      )
    } finally {
      await server.app.close()
    }
  })
})
