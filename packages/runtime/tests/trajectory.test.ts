import { describe, expect, it } from 'vitest'
import { ChronicleSchemaRegistry } from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import { registerContextManifestChronicleEvents } from '@bee-agent/context'
import { registerThreadChronicleEvents } from '@bee-agent/thread'
import {
  ExecutionWorld,
  IntersectionAuthorizationPolicy,
  registerExecutionChronicleEvents,
} from '@bee-agent/execution'
import { AgentLoop } from '../src/agent-loop.ts'
import {
  ModelRequestService,
  registerModelRequestChronicleEvents,
} from '../src/model-request-service.ts'
import { registerSchedulerChronicleEvents } from '../src/scheduler-events.ts'
import {
  InProcessToolSandbox,
  ToolExecutionService,
} from '../src/tool-execution.ts'
import type { ToolExecutionPort, ToolExecutor } from '../src/tool-execution.ts'
import { buildTurnTrajectory, replayGeneration } from '../src/trajectory.ts'
import { createFakeLlmRuntime } from '../src/testing.ts'
import type { LlmRuntime } from '../src/llm-runtime.ts'

function createStore(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerThreadChronicleEvents(registry)
  registerContextManifestChronicleEvents(registry)
  registerModelRequestChronicleEvents(registry)
  registerExecutionChronicleEvents(registry)
  registerSchedulerChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

/** A logical tool executor routed through the real ExecutionWorld. */
function scriptedTools(store: MemoryChronicleStore): ToolExecutionPort {
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
      return {
        output: { ok: true },
        content: 'ok',
        verification: [],
      }
    },
  }
  const world = new ExecutionWorld({
    store,
    policy: new IntersectionAuthorizationPolicy([
      {
        id: 'test',
        rules: [
          {
            capability: '*',
            decision: 'allow',
            reason: 'Test policy allows everything',
          },
        ],
      },
    ]),
    sandbox: new InProcessToolSandbox(executor),
  })
  return new ToolExecutionService(world, executor)
}

describe('trajectory views', () => {
  it('projects a completed tool-using turn with replayable generations', async () => {
    const store = createStore()
    const llm: LlmRuntime = createFakeLlmRuntime({
      script: [
        {
          type: 'respond',
          deltas: ['Checking.'],
          toolCalls: [{ toolId: 'lookup', callId: 'c1', input: { q: 'x' } }],
        },
        { type: 'respond', deltas: ['All done.'] },
      ],
    })
    const loop = new AgentLoop({
      store,
      modelRequests: new ModelRequestService({
        store,
        llm,
        promptVersion: 'test@1',
        structureVersion: 'sha256:structure-a',
      }),
      toolExecution: scriptedTools(store),
      toolSpecs: [
        {
          id: 'lookup',
          description: 'Test tool',
          inputSchema: { type: 'object' },
        },
      ],
    })

    const threadId = crypto.randomUUID()
    const result = await loop.runTurn({ threadId, input: 'Look up x.' })
    expect(result.status).toBe('completed')

    const trajectory = await buildTurnTrajectory(
      store,
      threadId,
      result.turn.id,
    )
    expect(trajectory.trigger).toBe('user')
    expect(trajectory.input).toBe('Look up x.')
    expect(trajectory.status).toBe('completed')

    // Two generations in order: the tool-calling step and the final answer.
    expect(trajectory.generations).toHaveLength(2)
    const [first, second] = trajectory.generations
    expect(first).toMatchObject({
      stepIndex: 0,
      attempt: 0,
      stopReason: 'tool_calls',
      structureVersion: 'sha256:structure-a',
    })
    expect(first!.inputDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(second).toMatchObject({ stepIndex: 1, stopReason: 'end_turn' })
    expect(first!.usage?.totalTokens).toBeGreaterThan(0)

    // The tool step cites its execution stream, capability, and decision.
    expect(trajectory.tools).toHaveLength(1)
    expect(trajectory.tools[0]).toMatchObject({
      toolId: 'lookup',
      callId: 'c1',
      outcome: 'completed',
      decision: 'allow',
    })
    expect(trajectory.tools[0]!.executionStreamId).toMatch(
      /^execution:[0-9a-f]{64}$/,
    )

    // Checkpoints record the committed step boundaries.
    expect(trajectory.checkpoints.length).toBeGreaterThanOrEqual(1)
    expect(trajectory.checkpoints.at(-1)!.stepIndex).toBe(2)

    // The exact model-visible context replays digest-verified.
    const replay = await replayGeneration(store, first!.requestId)
    expect(replay.bundle.messages[0]).toMatchObject({
      role: 'user',
      content: 'Look up x.',
    })
    expect(replay.manifest.sections.length).toBeGreaterThan(0)

    // Unknown turns fail loud instead of returning an empty view.
    await expect(
      buildTurnTrajectory(store, threadId, crypto.randomUUID()),
    ).rejects.toThrow(/not found/)
    await store.close()
  })
})
