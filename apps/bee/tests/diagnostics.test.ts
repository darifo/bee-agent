import { describe, expect, it } from 'vitest'
import {
  ChronicleSchemaRegistry,
  registerMemoryChronicleEvents,
  registerStructureChronicleEvents,
  registerWorldChronicleEvents,
} from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import { registerThreadChronicleEvents } from '@bee-agent/thread'
import { registerRuntimeChronicleEvents } from '@bee-agent/runtime'
import { registerKanbanChronicleEvents } from '@bee-agent/kanban'
import { createMemoryKanbanStore } from '@bee-agent/kanban/testing'
import { EmbeddedMemoryProvider } from '@bee-agent/memory-bee'
import { registerLearningChronicleEvents } from '@bee-agent/learning'
import { createFakeLlmRuntime } from '@bee-agent/runtime/testing'
import { buildBeeServer } from '../src/index.ts'
import type { BeeServer } from '../src/index.ts'

function createRegistryStore(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerStructureChronicleEvents(registry)
  registerThreadChronicleEvents(registry)
  registerRuntimeChronicleEvents(registry)
  registerMemoryChronicleEvents(registry)
  registerWorldChronicleEvents(registry)
  registerLearningChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

describe('GET /diagnostics (bee doctor)', () => {
  it('summarizes every subsystem in one call', async () => {
    const store = createRegistryStore()
    const server: BeeServer = await buildBeeServer({
      store,
      kanban: createMemoryKanbanStore(
        (() => {
          const registry = new ChronicleSchemaRegistry()
          registerKanbanChronicleEvents(registry)
          return registry
        })(),
      ),
      llm: createFakeLlmRuntime({ script: [] }),
      memory: new EmbeddedMemoryProvider({ store }),
      scheduler: {},
      learning: { intervalMs: 0 },
      logger: false,
    })
    await server.app.listen({ host: '127.0.0.1', port: 0 })
    await server.app.ready()
    const baseUrl = `http://127.0.0.1:${
      (server.app.server.address() as { port: number }).port
    }`
    try {
      const response = await fetch(`${baseUrl}/diagnostics`)
      expect(response.status).toBe(200)
      const d = (await response.json()) as {
        status: string
        structure: {
          activeVersion: string | null
          restartRequired: boolean
          doctor: { issues: unknown[] }
        }
        memory: {
          enabled: true
          health: { status: string }
          claims: { total: number; active: number }
        }
        scheduler: { enabled: boolean; triggers: number }
        learning: { enabled: true; byStatus: Record<string, number> }
        threads: { streams: number }
      }
      expect(d.status).toBe('ok')
      expect(d.structure.activeVersion).toMatch(/^sha256:/)
      expect(d.structure.restartRequired).toBe(false)
      expect(Array.isArray(d.structure.doctor.issues)).toBe(true)
      expect(d.memory.enabled).toBe(true)
      expect(d.memory.health.status).toBe('healthy')
      expect(d.memory.claims.total).toBe(0)
      expect(d.scheduler.enabled).toBe(true)
      expect(d.learning.enabled).toBe(true)
      expect(d.learning.byStatus).toMatchObject({ draft: 0, review: 0 })
      expect(d.threads.streams).toBe(0)
    } finally {
      await server.app.close()
    }
  })

  it('reports degraded when the memory provider is unavailable', async () => {
    const store = createRegistryStore()
    const down = {} as never
    const { RemoteMemoryProvider } = await import('@bee-agent/memory-remote')
    const server: BeeServer = await buildBeeServer({
      store,
      kanban: createMemoryKanbanStore(
        (() => {
          const registry = new ChronicleSchemaRegistry()
          registerKanbanChronicleEvents(registry)
          return registry
        })(),
      ),
      llm: createFakeLlmRuntime({ script: [] }),
      memory: new RemoteMemoryProvider({
        transport: down,
        store,
        failureThreshold: 1,
      }),
      logger: false,
    })
    await server.app.listen({ host: '127.0.0.1', port: 0 })
    await server.app.ready()
    const baseUrl = `http://127.0.0.1:${
      (server.app.server.address() as { port: number }).port
    }`
    try {
      // One failed call opens the circuit; diagnostics then sees it.
      await fetch(`${baseUrl}/memory/claims`)
      const d = (await (await fetch(`${baseUrl}/diagnostics`)).json()) as {
        status: string
        memory: { health: { status: string } }
      }
      expect(d.memory.health.status).toBe('unavailable')
      expect(d.status).toBe('degraded')
    } finally {
      await server.app.close()
    }
  })
})
