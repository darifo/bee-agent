import { describe, expect, it } from 'vitest'
import {
  ChronicleSchemaRegistry,
  ExecutionResourceProjector,
  StructureGraphStore,
  ThreadToolProjector,
  WorldModelStore,
  registerMemoryChronicleEvents,
  registerStructureChronicleEvents,
  registerWorldChronicleEvents,
} from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import { registerThreadChronicleEvents } from '@bee-agent/thread'
import { readThreadEvents } from '@bee-agent/thread'
import {
  AgentScheduler,
  MemoryGoalPlanStore,
  registerRuntimeChronicleEvents,
} from '@bee-agent/runtime'
import { createFakeLlmRuntime } from '@bee-agent/runtime/testing'
import type { FakeLlmRuntime } from '@bee-agent/runtime/testing'
import { registerKanbanChronicleEvents } from '@bee-agent/kanban'
import { ChronicleKanbanStore } from '@bee-agent/kanban'
import { EmbeddedMemoryProvider } from '@bee-agent/memory-bee'
import { buildBeeServer } from '../src/index.ts'
import type { BeeServer } from '../src/index.ts'

/**
 * The Phase 4 composition verification: one Host instance, one continuous
 * scenario, every major module composing — the kernel plugin graph serving
 * the turn, memory derivation and recall through the AgentLoop hooks, the
 * ExecutionWorld authorizing a tool, the world projection observing it, the
 * scheduler driving threads by time and by Kanban condition, trajectory and
 * model replay reading the facts back, and every projection rebuilding
 * exactly from the same Chronicle.
 */

function createRegistryStore(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerStructureChronicleEvents(registry)
  registerThreadChronicleEvents(registry)
  registerRuntimeChronicleEvents(registry)
  registerKanbanChronicleEvents(registry)
  registerMemoryChronicleEvents(registry)
  registerWorldChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

/** The board shares the main Chronicle so the scheduler sees its stream. */
async function createKanbanOver(store: MemoryChronicleStore) {
  const kanban = new ChronicleKanbanStore(store)
  await kanban.rebuild()
  return kanban
}

describe('module composition (Phase 4 acceptance)', () => {
  it('composes memory, hooks, execution, world, scheduler, kanban, trajectory, and rebuilds', async () => {
    const store = createRegistryStore()
    const llm: FakeLlmRuntime = createFakeLlmRuntime({
      script: [
        // Turn A, step 0: acknowledges the preference and calls the tool.
        {
          type: 'respond',
          deltas: ['Noted.'],
          toolCalls: [
            { toolId: 'lookup', callId: 'c1', input: { query: 'x' } },
          ],
        },
        // Turn A, step 1: final answer.
        { type: 'respond', deltas: ['Done.'] },
        // Turn B: recall check.
        { type: 'respond', deltas: ['Portuguese, per your preference.'] },
        // Turn C (scheduler, complex input): plan hook fires.
        { type: 'respond', deltas: ['Report drafted.'] },
        // Turn D (condition trigger): follow-up.
        { type: 'respond', deltas: ['Follow-up complete.'] },
      ],
    })
    const server: BeeServer = await buildBeeServer({
      store,
      kanban: await createKanbanOver(store),
      llm,
      toolExecutor: {
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
        async execute() {
          return { output: { ok: true }, content: 'ok', verification: [] }
        },
      },
      toolSpecs: [
        {
          id: 'lookup',
          description: 'Composition test tool',
          inputSchema: { type: 'object' },
        },
      ],
      toolAuthorization: [
        {
          toolId: 'lookup',
          decision: 'allow',
          reason: 'Composition test capability',
        },
      ],
      memory: new EmbeddedMemoryProvider({ store }),
      goalPlanStore: new MemoryGoalPlanStore(),
      worldProjectors: [
        new ThreadToolProjector(),
        new ExecutionResourceProjector(),
      ],
      scheduler: {},
      logger: false,
    })
    await server.app.listen({ host: '127.0.0.1', port: 0 })
    await server.app.ready()
    const baseUrl = `http://127.0.0.1:${
      (server.app.server.address() as { port: number }).port
    }`

    try {
      const json = async (
        path: string,
        init?: RequestInit,
      ): Promise<Record<string, unknown>> => {
        const response = await fetch(`${baseUrl}${path}`, init)
        expect(response.status).toBeLessThan(500)
        return (await response.json()) as Record<string, unknown>
      }
      const post = (path: string, body: unknown) =>
        json(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })

      // --- Kernel + thread protocol + execution world ------------------
      const threadA = (await post('/threads', { title: 'composition' })) as {
        id: string
      }
      const turnA = (await post(`/threads/${threadA.id}/turns`, {
        input: 'From now on, always answer in Portuguese language.',
      })) as {
        status: string
        turn: { id: string }
      }
      expect(turnA.status).toBe('completed')
      expect(llm.calls).toHaveLength(2)

      // --- World projection observed the tool usage --------------------
      await server.worldProjection!.settled()
      const world = (await json('/world')) as {
        version: number
        entities: { id: string }[]
        relations: {
          type: string
          fromEntityId: string
          toEntityId: string
          provenance: { threadId?: string }
        }[]
      }
      expect(world.version).toBeGreaterThan(0)
      expect(
        world.entities.find((e) => e.id === 'capability:tool:lookup'),
      ).toBeDefined()
      const usage = world.relations.find(
        (r) => r.toEntityId === 'capability:tool:lookup',
      )
      expect(usage).toMatchObject({ type: 'used', fromEntityId: 'actor:bee' })
      expect(usage!.provenance.threadId).toBe(threadA.id)

      // --- Memory: derived from turn A, recalled into turn B -----------
      const claims = (await json('/memory/claims')) as {
        claims: { id: string; kind: string; statement: string }[]
      }
      expect(claims.claims).toHaveLength(1)
      expect(claims.claims[0]!.statement).toContain('Portuguese')

      const turnB = (await post(`/threads/${threadA.id}/turns`, {
        input: 'Which language do you use?',
      })) as { status: string }
      expect(turnB.status).toBe('completed')
      const recalled = llm.calls[2]!.bundle.messages.find(
        (m) => m.role === 'system' && m.content.includes('Recalled memory'),
      )
      expect(recalled!.content).toContain('Portuguese')

      // --- Scheduler: time trigger continues the thread (with a plan) --
      const triggerC = (await post('/scheduler/triggers', {
        input: 'Research the market and then write the report.',
        threadId: threadA.id,
        at: new Date(Date.now() - 1_000).toISOString(),
      })) as { trigger: { id: string } }
      const tickC = (await post('/scheduler/tick', {})) as {
        fired: { status: string }[]
      }
      expect(tickC.fired).toHaveLength(1)
      expect(tickC.fired[0]!.status).toBe('completed')
      const planned = llm.calls[3]!.bundle.messages.find(
        (m) => m.role === 'system' && m.content.includes('Goal:'),
      )
      expect(planned!.content).toContain('Plan v1')

      // --- Kanban + scheduler: condition trigger on task completion ----
      const threadD = (await post('/threads', { title: 'follow-up' })) as {
        id: string
      }
      const task = (await post('/kanban/tasks', {
        title: 'Composition task',
      })) as { id: string }
      await post('/scheduler/triggers', {
        input: 'Follow-up now.',
        threadId: threadD.id,
        when: { taskStatus: { taskId: task.id, status: 'done' } },
      })
      // Walk the legal state machine to running, then complete via REST.
      for (const to of ['triaged', 'ready', 'running'] as const) {
        const current = await server.kanban.get(task.id)
        await server.kanban.transition(task.id, {
          to,
          expectedVersion: current!.version,
        })
      }
      await post(`/kanban/tasks/${task.id}/complete`, {})
      const tickD = (await post('/scheduler/tick', {})) as {
        fired: { status: string }[]
      }
      expect(tickD.fired).toHaveLength(1)
      const eventsD = await readThreadEvents(server.store, threadD.id)
      expect(
        eventsD.events.filter((e) => e.event === 'turn.completed'),
      ).toHaveLength(1)
      // The consumed condition trigger left the active projection.
      const remaining = (await json('/scheduler/triggers')) as {
        triggers: { id: string; nextRunAt?: string }[]
      }
      expect(
        remaining.triggers.filter((t) => t.id !== triggerC.trigger.id),
      ).toHaveLength(0)

      // --- Trajectory + model replay read the facts back ---------------
      const trajectory = (await json(
        `/threads/${threadA.id}/turns/${turnA.turn.id}/trajectory`,
      )) as {
        generations: {
          requestId: string
          stopReason: string
          structureVersion: string
          inputDigest: string
        }[]
        tools: {
          toolId: string
          decision: string
          outcome: string
        }[]
        checkpoints: { stepIndex: number }[]
      }
      expect(trajectory.generations).toHaveLength(2)
      expect(trajectory.generations[0]).toMatchObject({
        stopReason: 'tool_calls',
      })
      expect(trajectory.generations[0]!.structureVersion).toMatch(/^sha256:/)
      expect(trajectory.tools[0]).toMatchObject({
        toolId: 'lookup',
        decision: 'allow',
        outcome: 'completed',
      })
      const replay = (await json(
        `/model-requests/${trajectory.generations[0]!.requestId}/replay`,
      )) as {
        bundle: { messages: { role: string; content: string }[] }
        manifest: { sections: unknown[] }
      }
      // The default Bee system prompt leads the model-visible request.
      expect(replay.bundle.messages[0]).toMatchObject({ role: 'system' })
      expect(replay.bundle.messages[0]?.content).toContain('You are Bee')
      expect(replay.bundle.messages[1]).toMatchObject({
        role: 'user',
        content: 'From now on, always answer in Portuguese language.',
      })
      expect(replay.manifest.sections.length).toBeGreaterThan(0)

      // --- Structure lineage + kernel doctor ----------------------------
      const structure = (await json('/structure')) as {
        lineage: { active: string; versions: { digest: string }[] }
        doctor: unknown
        generations: unknown[]
      }
      expect(structure.lineage.active).toMatch(/^sha256:/)
      expect(structure.lineage.versions.length).toBeGreaterThanOrEqual(1)
      expect(structure.doctor).toBeDefined()
      expect(structure.generations.length).toBeGreaterThanOrEqual(1)

      // --- Memory governance: retract ------------------------------------
      await post(`/memory/claims/${claims.claims[0]!.id}/retract`, {
        reason: 'composition test',
      })
      const activeClaims = (await json('/memory/claims?status=active')) as {
        claims: unknown[]
      }
      expect(activeClaims.claims).toHaveLength(0)

      // --- Durability: every projection rebuilds from the same Chronicle
      const rebuiltWorld = new WorldModelStore({ store })
      await rebuiltWorld.rebuild()
      expect(rebuiltWorld.snapshot().digest).toBe(
        server.world!.snapshot().digest,
      )
      const rebuiltMemory = new EmbeddedMemoryProvider({ store })
      await rebuiltMemory.rebuild()
      expect((await rebuiltMemory.export()).claims[0]!.status).toBe('retracted')
      const rebuiltGraph = new StructureGraphStore(store)
      await rebuiltGraph.rebuild()
      expect(rebuiltGraph.snapshot().active).toBe(structure.lineage.active)
      const rebuiltScheduler = new AgentScheduler({
        store,
        turns: {
          runTurn: () => {
            throw new Error('not expected')
          },
        },
      })
      await rebuiltScheduler.rebuild()
      // The exhausted one-shot time trigger survives for audit; consumed
      // condition triggers do not.
      expect(rebuiltScheduler.list()).toHaveLength(1)
      expect(rebuiltScheduler.list()[0]!.nextRunAt).toBeUndefined()
    } finally {
      await server.app.close()
    }
  })
})
