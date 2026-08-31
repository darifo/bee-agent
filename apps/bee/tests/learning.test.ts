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
import { createFakeLlmRuntime } from '@bee-agent/runtime/testing'
import { registerKanbanChronicleEvents } from '@bee-agent/kanban'
import { registerLearningChronicleEvents } from '@bee-agent/learning'
import { createMemoryKanbanStore } from '@bee-agent/kanban/testing'
import type { ToolExecutor } from '@bee-agent/runtime'
import { EmbeddedMemoryProvider } from '@bee-agent/memory-bee'
import { buildBeeServer } from '../src/index.ts'
import type { BeeServer } from '../src/index.ts'

/**
 * Phase 5 host integration: a real tool-using conversation feeds the slow
 * loop, which turns durable trajectories into a governed proposal; the
 * user then drives it through the lifecycle over REST.
 */

function createRegistryStore(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerStructureChronicleEvents(registry)
  registerThreadChronicleEvents(registry)
  registerRuntimeChronicleEvents(registry)
  registerKanbanChronicleEvents(registry)
  registerLearningChronicleEvents(registry)
  registerMemoryChronicleEvents(registry)
  registerWorldChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

function tooling(): ToolExecutor {
  const executor: ToolExecutor = {
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
  }
  return executor
}

describe('host learning integration (Phase 5)', () => {
  it('derives a skill proposal from a real conversation and governs its lifecycle', async () => {
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
      llm: createFakeLlmRuntime({
        script: [
          {
            type: 'respond',
            deltas: ['Working.'],
            toolCalls: [
              { toolId: 'lookup', callId: 'c1', input: { q: '1' } },
              { toolId: 'lookup', callId: 'c2', input: { q: '2' } },
              { toolId: 'lookup', callId: 'c3', input: { q: '3' } },
            ],
          },
          { type: 'respond', deltas: ['Done.'] },
        ],
      }),
      toolExecutor: tooling(),
      toolSpecs: [
        {
          id: 'lookup',
          description: 'Test tool',
          inputSchema: { type: 'object' },
        },
      ],
      toolAuthorization: [
        {
          toolId: 'lookup',
          decision: 'allow',
          reason: 'Integration capability',
        },
      ],
      memory: new EmbeddedMemoryProvider({ store }),
      // Timer disabled; the test drives runs manually.
      learning: { intervalMs: 0 },
      logger: false,
    })
    await server.app.listen({ host: '127.0.0.1', port: 0 })
    await server.app.ready()
    const baseUrl = `http://127.0.0.1:${
      (server.app.server.address() as { port: number }).port
    }`
    const json = async (path: string, init?: RequestInit) => {
      const response = await fetch(`${baseUrl}${path}`, init)
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      }
    }
    const post = (path: string, body: unknown) =>
      json(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    try {
      // A real tool-heavy turn produces the trajectory evidence.
      const thread = (await post('/threads', { title: 'learning' })).body as {
        id: string
      }
      const turn = (
        await post(`/threads/${thread.id}/turns`, {
          input: 'Look things up three times.',
        })
      ).body as { status: string }
      expect(turn.status).toBe('completed')

      // First slow-loop run turns the usage pattern into a proposal.
      const run1 = (await post('/learning/run', {})).body as {
        selectedTrajectories: number
        proposalsCreated: string[]
      }
      expect(run1.selectedTrajectories).toBe(1)
      expect(run1.proposalsCreated).toHaveLength(1)

      const listed = (await json('/learning/proposals')).body as {
        proposals: {
          id: string
          type: string
          targetKey: string
          status: string
          autonomyLevel: number
          origin: string
          basedOnTrajectoryIds: unknown[]
        }[]
      }
      const proposal = listed.proposals[0]!
      expect(proposal).toMatchObject({
        type: 'skill',
        targetKey: 'skill:lookup',
        status: 'draft',
        autonomyLevel: 2,
        origin: 'loop',
      })
      // Provenance cites the real turn.
      expect(proposal.basedOnTrajectoryIds).toHaveLength(1)

      // Re-running consolidates: the open target is skipped.
      const run2 = (await post('/learning/run', {})).body as {
        proposalsCreated: string[]
        skippedDuplicates: number
      }
      expect(run2.proposalsCreated).toHaveLength(0)
      expect(run2.skippedDuplicates).toBe(1)

      // Illegal jumps and stale versions are refused with 409.
      expect(
        (
          await post(`/learning/proposals/${proposal.id}/transition`, {
            to: 'promoted',
            expectedVersion: 1,
          })
        ).status,
      ).toBe(409)
      expect(
        (
          await post(`/learning/proposals/${proposal.id}/transition`, {
            to: 'review',
            expectedVersion: 42,
          })
        ).status,
      ).toBe(409)

      // The governed path: review → trial → promoted → rolled-back.
      for (const [to, reason] of [
        ['review', 'evidence looks useful'],
        ['trial', 'user starts a trial'],
        ['promoted', 'trial metrics improved'],
      ] as const) {
        const stepped = await post(
          `/learning/proposals/${proposal.id}/transition`,
          {
            to,
            expectedVersion: to === 'review' ? 1 : to === 'trial' ? 2 : 3,
            reason,
          },
        )
        expect(stepped.status).toBe(200)
      }
      const rolledBack = await post(
        `/learning/proposals/${proposal.id}/transition`,
        { to: 'rolled-back', expectedVersion: 4, reason: 'drift observed' },
      )
      expect(rolledBack.status).toBe(200)

      const final = (await json('/learning/proposals?status=rolled-back'))
        .body as { proposals: { id: string }[] }
      expect(final.proposals.map((p) => p.id)).toContain(proposal.id)

      // Unknown ids are 404.
      expect(
        (await json(`/learning/proposals/${crypto.randomUUID()}`)).status,
      ).toBe(404)
    } finally {
      await server.app.close()
    }
  })
})
