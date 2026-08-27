import { describe, expect, it } from 'vitest'
import {
  ChronicleSchemaRegistry,
  ThreadToolProjector,
  WorldModelStore,
  registerMemoryChronicleEvents,
  registerStructureChronicleEvents,
  registerWorldChronicleEvents,
} from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import { registerThreadChronicleEvents } from '@bee-agent/thread'
import { registerRuntimeChronicleEvents } from '@bee-agent/runtime'
import { createFakeLlmRuntime } from '@bee-agent/runtime/testing'
import type { FakeLlmStep } from '@bee-agent/runtime/testing'
import { registerKanbanChronicleEvents } from '@bee-agent/kanban'
import { createMemoryKanbanStore } from '@bee-agent/kanban/testing'
import type { ActionResult, ToolExecutor } from '@bee-agent/runtime'
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

function scriptedTools(): ToolExecutor {
  return {
    describe(call) {
      return {
        capability: `tool:${call.toolId}`,
        requirements: {
          readPaths: [],
          writePaths: [],
          networkTargets: [],
          commands: [],
          secretEnv: {},
        },
        expectedEffects: [`Execute tool '${call.toolId}'`],
        verification: ['Tool executor reports completion'],
      }
    },
    async execute(): Promise<ActionResult> {
      return { output: { ok: true }, content: 'ok', verification: [] }
    },
  }
}

const script: readonly FakeLlmStep[] = [
  {
    type: 'respond',
    deltas: ['Let me look that up.'],
    toolCalls: [{ toolId: 'lookup', callId: 'c1', input: { query: 'x' } }],
  },
  { type: 'respond', deltas: ['Done.'] },
]

async function withServer(
  fn: (server: BeeServer, baseUrl: string) => Promise<void>,
) {
  const server = await buildBeeServer({
    store: createRegistryStore(),
    kanban: (() => {
      const registry = new ChronicleSchemaRegistry()
      registerKanbanChronicleEvents(registry)
      return createMemoryKanbanStore(registry)
    })(),
    llm: createFakeLlmRuntime({ script }),
    toolExecutor: scriptedTools(),
    toolSpecs: [
      {
        id: 'lookup',
        description: 'Test lookup tool',
        inputSchema: { type: 'object' },
      },
    ],
    toolAuthorization: [
      {
        toolId: 'lookup',
        decision: 'allow',
        reason: 'Test-declared capability',
      },
    ],
    worldProjectors: [new ThreadToolProjector()],
    logger: false,
  })
  await server.app.listen({ host: '127.0.0.1', port: 0 })
  await server.app.ready()
  try {
    const address = server.app.server.address()
    const port =
      address !== null && typeof address === 'object' ? address.port : 0
    await fn(server, `http://127.0.0.1:${port}`)
  } finally {
    await server.app.close()
  }
}

describe('host world projection', () => {
  it('projects tool usage live and serves it read-only', async () => {
    await withServer(async (server, baseUrl) => {
      const threadResponse = await fetch(`${baseUrl}/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'world test' }),
      })
      const thread = (await threadResponse.json()) as { id: string }
      const turnResponse = await fetch(
        `${baseUrl}/threads/${thread.id}/turns`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: 'Please look up x.' }),
        },
      )
      const turn = (await turnResponse.json()) as { status: string }
      expect(turn.status).toBe('completed')

      await server.worldProjection!.settled()
      const worldResponse = await fetch(`${baseUrl}/world`)
      const snapshot = (await worldResponse.json()) as {
        version: number
        digest: string
        entities: { id: string; kind: string }[]
        relations: {
          type: string
          fromEntityId: string
          toEntityId: string
          provenance: { streamId: string; itemId?: string }
        }[]
      }
      expect(snapshot.version).toBeGreaterThan(0)
      expect(snapshot.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(
        snapshot.entities.find((e) => e.id === 'capability:tool:lookup'),
      ).toMatchObject({ kind: 'capability' })
      const usage = snapshot.relations.find((r) => r.type === 'used')
      expect(usage).toMatchObject({
        fromEntityId: 'actor:bee',
        toEntityId: 'capability:tool:lookup',
      })
      expect(usage!.provenance.streamId).toBe(`thread:${thread.id}`)

      // Filters narrow the view without mutating anything.
      const filtered = (await (
        await fetch(`${baseUrl}/world?kind=actor`)
      ).json()) as { entities: unknown[] }
      expect(filtered.entities).toHaveLength(1)

      // A restarted projection recovers the identical world from the log.
      const restarted = new WorldModelStore({ store: server.store })
      await restarted.rebuild()
      expect(restarted.snapshot().digest).toBe(server.world!.snapshot().digest)
    })
  })
})
