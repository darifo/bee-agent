import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { canonicalJson } from '@bee-agent/kernel'
import { registerContextManifestChronicleEvents } from '@bee-agent/context'
import { ChronicleSchemaRegistry } from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import {
  appendThreadEvents,
  newItem,
  newTurn,
  readThreadEvents,
  registerThreadChronicleEvents,
  itemStartedEvent,
  itemCompletedEvent,
  agentCheckpointEvent,
  turnStartedEvent,
} from '@bee-agent/thread'
import type { Item, ThreadEvent } from '@bee-agent/thread'
import { AgentLoop, CheckpointDigestMismatchError } from '../src/agent-loop.ts'
import { SystemPromptAssembler } from '../src/system-prompt.ts'
import {
  ModelRequestService,
  registerModelRequestChronicleEvents,
} from '../src/model-request-service.ts'
import { createFakeLlmRuntime } from '../src/testing.ts'
import type { LlmRuntime } from '../src/llm-runtime.ts'
import type {
  ToolExecutionCall,
  ToolExecutionPort,
} from '../src/tool-execution.ts'

function createStore(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerThreadChronicleEvents(registry)
  registerContextManifestChronicleEvents(registry)
  registerModelRequestChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

function modelRequests(store: MemoryChronicleStore, llm: LlmRuntime) {
  return new ModelRequestService({
    store,
    llm,
    promptVersion: 'test-prompt@1',
    structureVersion: 'sha256:test-structure',
  })
}

function historyDigest(history: unknown): string {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(history))
    .digest('hex')}`
}

/** A tool slot whose behavior is scripted per (toolId, callId). */
type ScriptedToolOutcome =
  | {
      readonly kind: 'result'
      readonly output: unknown
      readonly content: string
      readonly isError?: boolean | undefined
    }
  | {
      readonly kind: 'approval-required'
      readonly approvalId: string
      readonly title: string
      readonly detail?: string | undefined
    }

function scriptedTools(
  handlers: Record<
    string,
    (
      input: unknown,
      call: ToolExecutionCall & {
        readonly approval?: 'approved' | 'rejected' | undefined
      },
    ) => ScriptedToolOutcome | Promise<ScriptedToolOutcome>
  >,
): ToolExecutionPort {
  return {
    async execute(input) {
      const { call } = input
      if (input.approval === 'rejected') {
        return {
          kind: 'result',
          result: {
            output: { rejected: true },
            content: 'The user rejected this tool call.',
            isError: true,
            verification: [],
          },
        }
      }
      const handler = handlers[call.toolId] ?? handlers['*']
      if (handler === undefined) {
        return {
          kind: 'result',
          result: {
            output: {},
            content: 'no handler',
            verification: [],
          },
        }
      }
      const outcome = await handler(call.input, input)
      return outcome.kind === 'approval-required'
        ? { ...outcome, detail: outcome.detail ?? outcome.title }
        : {
            kind: 'result',
            result: {
              output: outcome.output,
              content: outcome.content,
              isError: outcome.isError,
              verification: [],
            },
          }
    },
  }
}

const NOW = '2026-08-25T10:00:00.000Z'

async function collectEvents(store: MemoryChronicleStore, threadId: string) {
  const page = await readThreadEvents(store, threadId)
  return page.events
}

type CompletedToolItem = Extract<Item, { type: 'tool_call' }>

/** Completed tool-call items, narrowed for payload assertions. */
function completedToolItems(
  events: readonly ThreadEvent[],
): CompletedToolItem[] {
  return events.flatMap((event) =>
    event.event === 'item.completed' && event.item.type === 'tool_call'
      ? [event.item]
      : [],
  )
}

describe('AgentLoop happy path', () => {
  it('runs a single-step turn to completion and records the lifecycle', async () => {
    const store = createStore()
    const llm = createFakeLlmRuntime({
      script: [{ type: 'respond', deltas: ['The answer is 42.'] }],
    })
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({}),
      now: () => NOW,
    })
    const threadId = crypto.randomUUID()

    const result = await loop.runTurn({
      threadId,
      input: 'What is the answer?',
    })

    expect(result.status).toBe('completed')
    if (result.status === 'completed') {
      expect(result.output).toBe('The answer is 42.')
      expect(result.turn.status).toBe('completed')
    }

    const events = await collectEvents(store, threadId)
    const kinds = events.map((event) => event.event)
    expect(kinds).toContain('turn.started')
    expect(kinds).toContain('item.started')
    expect(kinds).toContain('agent.checkpoint')
    expect(kinds).toContain('turn.completed')
    expect(kinds.filter((kind) => kind === 'item.delta')).toHaveLength(1)
    expect(events[0]?.event).toBe('turn.started')
    expect(events.at(-1)?.event).toBe('turn.completed')
  })

  it('runs a multi-step tool loop, recording tool calls and results', async () => {
    const store = createStore()
    const llm = createFakeLlmRuntime({
      script: [
        {
          type: 'respond',
          deltas: ['Let me compute.'],
          toolCalls: [
            { callId: 'c1', toolId: 'calculator', input: { a: 1, b: 2 } },
          ],
        },
        { type: 'respond', deltas: ['The result is 3.'] },
      ],
    })
    const calls: Array<{ toolId: string; input: unknown }> = []
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({
        calculator: (input) => {
          calls.push({ toolId: 'calculator', input })
          return { kind: 'result', output: 3, content: '3' }
        },
      }),
      now: () => NOW,
    })
    const threadId = crypto.randomUUID()

    const result = await loop.runTurn({ threadId, input: 'Add 1 and 2' })
    expect(result.status).toBe('completed')
    expect(calls).toEqual([{ toolId: 'calculator', input: { a: 1, b: 2 } }])

    const events = await collectEvents(store, threadId)
    expect(
      events.filter((event) => event.event === 'agent.checkpoint'),
    ).toHaveLength(2)
    expect(
      events.filter(
        (event) =>
          event.event === 'item.completed' && event.item.type === 'tool_call',
      ),
    ).toHaveLength(1)
    expect(llm.calls).toHaveLength(2)
    // The second generation saw the tool result in its message history.
    expect(
      llm.calls[1]?.bundle.messages.some((message) => message.role === 'tool'),
    ).toBe(true)
  })

  it('honors structured decisions as terminal output', async () => {
    const store = createStore()
    const llm = createFakeLlmRuntime({
      script: [
        { type: 'respond', decision: { action: 'respond', text: 'hi' } },
      ],
    })
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({}),
      now: () => NOW,
    })
    const result = await loop.runTurn({
      threadId: crypto.randomUUID(),
      input: 'respond',
    })
    expect(result.status).toBe('completed')
    if (result.status === 'completed') {
      expect(result.output).toBe('{"action":"respond","text":"hi"}')
    }
  })
})

describe('AgentLoop system prompt', () => {
  it('prepends a memoized system message to every request', async () => {
    const store = createStore()
    const llm = createFakeLlmRuntime({
      script: [
        {
          type: 'respond',
          toolCalls: [{ callId: 'c1', toolId: 'probe', input: {} }],
        },
        { type: 'respond', deltas: ['done'] },
      ],
    })
    let resolutions = 0
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({
        probe: () => ({ kind: 'result', output: {}, content: 'ok' }),
      }),
      systemPrompt: () => {
        resolutions += 1
        return 'You are Bee.'
      },
      now: () => NOW,
    })
    const result = await loop.runTurn({
      threadId: crypto.randomUUID(),
      input: 'go',
    })
    expect(result.status).toBe('completed')
    // The provider resolved once despite two generations.
    expect(resolutions).toBe(1)
    for (const call of llm.calls) {
      expect(call.bundle.messages[0]).toEqual({
        role: 'system',
        content: 'You are Bee.',
      })
      expect(call.bundle.messages[1]?.role).toBe('user')
    }
    // The identical message object: the prefix is byte-stable.
    expect(llm.calls[0]?.bundle.messages[0]).toBe(
      llm.calls[1]?.bundle.messages[0],
    )
  })

  it('accepts a SystemPromptAssembler for budgeted sections', async () => {
    const store = createStore()
    const llm = createFakeLlmRuntime({
      script: [{ type: 'respond', deltas: ['hi'] }],
    })
    const assembler = new SystemPromptAssembler({
      promptVersion: 'bee-system@1.0.0',
      structureVersion: 'sha256:test-structure',
      sections: [
        { id: 'identity', priority: 1, content: 'You are Bee.' },
        { id: 'environment', priority: 10, content: 'Sandboxed host.' },
      ],
    })
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({}),
      systemPrompt: assembler,
      now: () => NOW,
    })
    await loop.runTurn({ threadId: crypto.randomUUID(), input: 'go' })
    expect(llm.calls[0]?.bundle.messages[0]).toEqual({
      role: 'system',
      content: 'You are Bee.\n\nSandboxed host.',
    })
  })
})

describe('AgentLoop thread continuity', () => {
  it('carries prior turns into later ones as one conversation', async () => {
    const store = createStore()
    const llm = createFakeLlmRuntime({
      script: [
        { type: 'respond', deltas: ['First answer.'] },
        { type: 'respond', deltas: ['Second answer.'] },
      ],
    })
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({}),
      now: () => NOW,
    })
    const threadId = crypto.randomUUID()
    await loop.runTurn({ threadId, input: 'first question' })
    const second = await loop.runTurn({ threadId, input: 'second question' })
    expect(second.status).toBe('completed')

    // The second generation saw the whole thread, newest last.
    const roles = llm.calls[1]?.bundle.messages.map((m) => m.role)
    expect(roles).toEqual(['user', 'assistant', 'user'])
    expect(llm.calls[1]?.bundle.messages[2]).toMatchObject({
      role: 'user',
      content: 'second question',
    })
  })

  it('can opt out of carry per loop', async () => {
    const store = createStore()
    const llm = createFakeLlmRuntime({
      script: [
        { type: 'respond', deltas: ['First.'] },
        { type: 'respond', deltas: ['Second.'] },
      ],
    })
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({}),
      carryThreadHistory: false,
      now: () => NOW,
    })
    const threadId = crypto.randomUUID()
    await loop.runTurn({ threadId, input: 'first' })
    await loop.runTurn({ threadId, input: 'second' })
    expect(llm.calls[1]?.bundle.messages).toEqual([
      { role: 'user', content: 'second' },
    ])
  })
})

describe('AgentLoop level-2 compaction', () => {
  it('summarizes the covered prefix over threshold and folds the view', async () => {
    const store = createStore()
    const big = 'x'.repeat(400)
    const llm = createFakeLlmRuntime({
      script: [
        // Turn 1: a tool round trip with a large result.
        {
          type: 'respond',
          toolCalls: [{ callId: 'c1', toolId: 'probe', input: {} }],
        },
        { type: 'respond', deltas: [big] },
        // Turn 2: the summarizer call consumes this step, then the answer.
        { type: 'respond', deltas: ['The user probed once and got a result.'] },
        { type: 'respond', deltas: ['Second answer.'] },
      ],
    })
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({
        probe: () => ({ kind: 'result', output: {}, content: big }),
      }),
      contextCompaction: { thresholdTokens: 50, keepRecentMessages: 2 },
      now: () => NOW,
    })
    const threadId = crypto.randomUUID()
    await loop.runTurn({ threadId, input: 'probe once' })
    const second = await loop.runTurn({ threadId, input: 'continue' })
    expect(second.status).toBe('completed')

    // calls: turn1 g0, turn1 g1, summarizer, turn2 gen.
    expect(llm.calls).toHaveLength(4)
    const summarizer = llm.calls[2]?.bundle
    expect(summarizer?.tools).toEqual([])
    expect(summarizer?.messages[0]?.role).toBe('system')
    expect(summarizer?.messages[0]?.content).toMatch(
      /Summarize the conversation/,
    )

    const view = llm.calls[3]?.bundle.messages
    // [summary(user), ...two most recent original messages, new user input]
    expect(view?.[0]?.content).toMatch(
      /Summary of the earlier conversation \(3 messages\)/,
    )
    expect(view?.[0]?.content).toContain('The user probed once')
    expect(view?.slice(1).map((m) => m.role)).toEqual(['assistant', 'user'])

    // The summary is durable; Chronicle keeps the full history untouched.
    const events = await collectEvents(store, threadId)
    const compacted = events.filter((e) => e.event === 'context.compacted')
    expect(compacted).toHaveLength(1)
    expect(
      events.filter(
        (e) => e.event === 'item.completed' && e.item.type === 'tool_call',
      ),
    ).toHaveLength(1)
  })

  it('breaks after the attempt budget instead of looping', async () => {
    const store = createStore()
    const big = 'y'.repeat(400)
    const llm = createFakeLlmRuntime({
      script: [
        {
          type: 'fail',
          error: { message: 'summarizer down', retryability: 'retryable' },
        },
        { type: 'respond', deltas: ['Second answer anyway.'] },
      ],
    })
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({}),
      // Pre-seed a history big enough to trigger, via a first turn that
      // itself cannot compact (min covered messages guard).
      contextCompaction: {
        thresholdTokens: 20,
        keepRecentMessages: 1,
        maxAttemptsPerTurn: 1,
      },
      now: () => NOW,
    })
    const threadId = crypto.randomUUID()
    // Turn 1 builds a two-message history below any compaction trigger.
    const first = createFakeLlmRuntime({
      script: [{ type: 'respond', deltas: [big] }],
    })
    const seeding = new AgentLoop({
      modelRequests: modelRequests(store, first),
      store,
      toolExecution: scriptedTools({}),
      now: () => NOW,
    })
    await seeding.runTurn({ threadId, input: big })
    // Turn 2 exceeds the threshold: one summarizer attempt fails, the
    // breaker stops retries, and the turn still completes unfolded.
    const second = await loop.runTurn({ threadId, input: 'continue' })
    expect(second.status).toBe('completed')
    const events = await collectEvents(store, threadId)
    expect(events.filter((e) => e.event === 'context.compacted')).toHaveLength(
      0,
    )
    // The model saw the full history — no summary message.
    const view = llm.calls.at(-1)?.bundle.messages
    expect(
      view?.some((m) => m.content.includes('Summary of the earlier')),
    ).toBe(false)
  })
})

describe('AgentLoop context policy', () => {
  it('elides old tool results from the model view, keeping Chronicle full', async () => {
    const store = createStore()
    const big = 'x'.repeat(300)
    const llm = createFakeLlmRuntime({
      script: [
        {
          type: 'respond',
          toolCalls: [{ callId: 'c1', toolId: 'probe', input: {} }],
        },
        {
          type: 'respond',
          toolCalls: [{ callId: 'c2', toolId: 'probe', input: {} }],
        },
        {
          type: 'respond',
          toolCalls: [{ callId: 'c3', toolId: 'probe', input: {} }],
        },
        { type: 'respond', deltas: ['done'] },
      ],
    })
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({
        probe: () => ({ kind: 'result', output: {}, content: big }),
      }),
      toolResultCompaction: {
        toolResultBudgetTokens: 10,
        keepRecentToolResults: 1,
      },
      now: () => NOW,
    })
    const threadId = crypto.randomUUID()
    const result = await loop.runTurn({ threadId, input: 'probe thrice' })
    expect(result.status).toBe('completed')

    // The third generation saw c1 as a placeholder, not the full output.
    const visibleTools = llm.calls[2]?.bundle.messages.filter(
      (message) => message.role === 'tool',
    )
    expect(visibleTools?.map((message) => message.callId)).toEqual(['c1', 'c2'])
    expect(visibleTools?.[0]?.content).toMatch(/elided by context policy/)
    expect(visibleTools?.[1]?.content).toBe(big)

    // Chronicle keeps every tool result at full fidelity.
    const recorded = completedToolItems(await collectEvents(store, threadId))
    expect(recorded.map((item) => item.payload.content)).toEqual([
      big,
      big,
      big,
    ])

    // The manifest records what the model did not see, and why.
    const omissionReasons: string[] = []
    for (const streamId of await store.listStreams()) {
      if (!streamId.startsWith('model-request:')) continue
      for await (const event of store.readStream(streamId)) {
        if (event.eventType !== 'context.manifest') continue
        const manifest = (
          event.payload as { manifest: { omissions: { reason: string }[] } }
        ).manifest
        for (const omission of manifest.omissions) {
          omissionReasons.push(omission.reason)
        }
      }
    }
    expect(omissionReasons.length).toBeGreaterThan(0)
    expect(omissionReasons[0]).toMatch(/context-policy:tool-result-budget/)
  })
})

describe('AgentLoop tool approval', () => {
  it('suspends on approval-required and resumes on approve', async () => {
    const store = createStore()
    const llm = createFakeLlmRuntime({
      script: [
        {
          type: 'respond',
          deltas: ['I need to deploy.'],
          toolCalls: [
            { callId: 'd1', toolId: 'deploy', input: { env: 'prod' } },
          ],
        },
        { type: 'respond', deltas: ['Deployed.'] },
      ],
    })
    let approved = false
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({
        deploy: () => {
          if (!approved) {
            return {
              kind: 'approval-required',
              approvalId: 'approval-1',
              title: 'Deploy to prod?',
            }
          }
          return { kind: 'result', output: { ok: true }, content: 'deployed' }
        },
      }),
      now: () => NOW,
    })
    const threadId = crypto.randomUUID()

    const first = await loop.runTurn({ threadId, input: 'Deploy' })
    expect(first.status).toBe('suspended')
    if (first.status === 'suspended') {
      expect(first.approval.approvalId).toBe('approval-1')
    }
    const turnId = first.turn.id

    // Before approval, no tool result is recorded.
    let events = await collectEvents(store, threadId)
    expect(
      events.filter(
        (event) =>
          event.event === 'item.completed' && event.item.type === 'tool_call',
      ),
    ).toHaveLength(0)

    approved = true
    const second = await loop.resumeTurn({
      threadId,
      turnId,
      approvalId: 'approval-1',
      decision: 'approved',
    })
    expect(second.status).toBe('completed')

    events = await collectEvents(store, threadId)
    expect(
      events.filter(
        (event) =>
          event.event === 'item.completed' && event.item.type === 'approval',
      ),
    ).toHaveLength(1)
    expect(
      events.filter(
        (event) =>
          event.event === 'item.completed' && event.item.type === 'tool_call',
      ),
    ).toHaveLength(1)
  })

  it('resumes with rejection without executing the tool', async () => {
    const store = createStore()
    const llm = createFakeLlmRuntime({
      script: [
        {
          type: 'respond',
          deltas: ['Deploying…'],
          toolCalls: [{ callId: 'd1', toolId: 'deploy', input: {} }],
        },
        { type: 'respond', deltas: ['Understood.'] },
      ],
    })
    let executed = false
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({
        deploy: () => {
          executed = true
          return { kind: 'approval-required', approvalId: 'a1', title: 'OK?' }
        },
      }),
      now: () => NOW,
    })
    const threadId = crypto.randomUUID()

    const first = await loop.runTurn({ threadId, input: 'Deploy' })
    const turnId = first.turn.id
    expect(first.status).toBe('suspended')

    const second = await loop.resumeTurn({
      threadId,
      turnId,
      approvalId: 'a1',
      decision: 'rejected',
    })
    expect(second.status).toBe('completed')
    expect(executed).toBe(true) // the approve-required handler ran once
  })
})

describe('AgentLoop tool concurrency', () => {
  /** Records in-flight count and completion order across executions. */
  function concurrencyProbe(
    concurrencyFor: (toolId: string) => 'parallel' | 'exclusive' | undefined,
  ) {
    let active = 0
    let maxActive = 0
    const completedInOrder: string[] = []
    const port: ToolExecutionPort = {
      async execute(input) {
        active += 1
        maxActive = Math.max(maxActive, active)
        // Let a sibling dispatch start before this one settles.
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        completedInOrder.push(input.call.callId)
        return {
          kind: 'result',
          result: {
            output: { callId: input.call.callId },
            content: `result:${input.call.callId}`,
            verification: [],
          },
        }
      },
      concurrency: (call) => concurrencyFor(call.toolId) ?? 'exclusive',
    }
    return { port, stats: () => ({ maxActive, completedInOrder }) }
  }

  it('runs parallel-safe calls concurrently and commits results in model order', async () => {
    const store = createStore()
    const llm = createFakeLlmRuntime({
      script: [
        {
          type: 'respond',
          toolCalls: [
            { callId: 'c1', toolId: 'read_a', input: {} },
            { callId: 'c2', toolId: 'read_b', input: {} },
          ],
        },
        { type: 'respond', deltas: ['done'] },
      ],
    })
    const probe = concurrencyProbe(() => 'parallel')
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: probe.port,
      now: () => NOW,
    })
    const result = await loop.runTurn({
      threadId: crypto.randomUUID(),
      input: 'read both',
    })
    expect(result.status).toBe('completed')
    expect(probe.stats().maxActive).toBe(2)
    // Tool results enter the next request in the model's call order.
    const toolMessages = llm.calls[1]?.bundle.messages.filter(
      (message) => message.role === 'tool',
    )
    expect(toolMessages?.map((message) => message.callId)).toEqual(['c1', 'c2'])
  })

  it('keeps undeclared tools exclusive', async () => {
    const store = createStore()
    const llm = createFakeLlmRuntime({
      script: [
        {
          type: 'respond',
          toolCalls: [
            { callId: 'c1', toolId: 'read_a', input: {} },
            { callId: 'c2', toolId: 'read_b', input: {} },
          ],
        },
        { type: 'respond', deltas: ['done'] },
      ],
    })
    const probe = concurrencyProbe(() => undefined)
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: probe.port,
      now: () => NOW,
    })
    await loop.runTurn({ threadId: crypto.randomUUID(), input: 'read both' })
    expect(probe.stats().maxActive).toBe(1)
  })

  it('bounds parallelism with maxParallelToolCalls', async () => {
    const store = createStore()
    const llm = createFakeLlmRuntime({
      script: [
        {
          type: 'respond',
          toolCalls: [
            { callId: 'c1', toolId: 'read_a', input: {} },
            { callId: 'c2', toolId: 'read_b', input: {} },
          ],
        },
        { type: 'respond', deltas: ['done'] },
      ],
    })
    const probe = concurrencyProbe(() => 'parallel')
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: probe.port,
      maxParallelToolCalls: 1,
      now: () => NOW,
    })
    await loop.runTurn({ threadId: crypto.randomUUID(), input: 'read both' })
    expect(probe.stats().maxActive).toBe(1)
  })

  it('finishes a suspended step’s remaining calls after resume', async () => {
    const store = createStore()
    const llm = createFakeLlmRuntime({
      script: [
        {
          type: 'respond',
          deltas: ['Two tools.'],
          toolCalls: [
            { callId: 'd1', toolId: 'deploy', input: {} },
            { callId: 'r1', toolId: 'read_a', input: {} },
          ],
        },
        { type: 'respond', deltas: ['Both settled.'] },
      ],
    })
    const executed: string[] = []
    let approved = false
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({
        deploy: () => {
          executed.push('deploy')
          if (!approved) {
            return {
              kind: 'approval-required',
              approvalId: 'a1',
              title: 'Deploy?',
            }
          }
          return { kind: 'result', output: {}, content: 'deployed' }
        },
        read_a: () => {
          executed.push('read_a')
          return { kind: 'result', output: {}, content: 'read' }
        },
      }),
      now: () => NOW,
    })
    const threadId = crypto.randomUUID()
    const first = await loop.runTurn({ threadId, input: 'go' })
    expect(first.status).toBe('suspended')

    approved = true
    const second = await loop.resumeTurn({
      threadId,
      turnId: first.turn.id,
      approvalId: 'a1',
      decision: 'approved',
    })
    // The sibling call the suspension skipped ran after the resume.
    expect(executed).toEqual(['deploy', 'deploy', 'read_a'])
    expect(second.status).toBe('completed')
    // The final generation saw both tool results in model order.
    const toolMessages = llm.calls[1]?.bundle.messages.filter(
      (message) => message.role === 'tool',
    )
    expect(toolMessages?.map((message) => message.callId)).toEqual(['d1', 'r1'])
  })
})

describe('AgentLoop failure and cancellation', () => {
  it('isolates a throwing tool as an error result the model reacts to', async () => {
    const store = createStore()
    const llm = createFakeLlmRuntime({
      script: [
        {
          type: 'respond',
          toolCalls: [{ callId: 'c1', toolId: 'broken', input: {} }],
        },
        { type: 'respond', deltas: ['Recovered after the tool error.'] },
      ],
    })
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({
        broken: () => {
          throw new Error('invalid action declaration')
        },
      }),
      now: () => NOW,
    })
    const threadId = crypto.randomUUID()
    const result = await loop.runTurn({ threadId, input: 'run broken tool' })
    expect(result.status).toBe('completed')
    if (result.status === 'completed') {
      expect(result.output).toBe('Recovered after the tool error.')
    }
    const events = await collectEvents(store, threadId)
    // The failed call is a completed tool item with an error result.
    const toolCompleted = completedToolItems(events)[0]
    expect(toolCompleted?.payload).toMatchObject({
      isError: true,
      content: 'Tool execution failed: invalid action declaration',
    })
    // The next generation saw the error as a tool message.
    expect(
      llm.calls[1]?.bundle.messages.some(
        (message) =>
          message.role === 'tool' && message.content.includes('invalid action'),
      ),
    ).toBe(true)
  })

  it('never executes a tool call with malformed arguments', async () => {
    const store = createStore()
    const llm = createFakeLlmRuntime({
      script: [
        {
          type: 'respond',
          toolCalls: [
            {
              callId: 'c1',
              toolId: 'calculator',
              input: {},
              inputError: 'Tool arguments were not valid JSON: {oops',
            },
          ],
        },
        { type: 'respond', deltas: ['Corrected.'] },
      ],
    })
    let executed = false
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({
        calculator: () => {
          executed = true
          return { kind: 'result', output: 3, content: '3' }
        },
      }),
      now: () => NOW,
    })
    const threadId = crypto.randomUUID()
    const result = await loop.runTurn({ threadId, input: 'compute' })
    expect(result.status).toBe('completed')
    expect(executed).toBe(false)
    const events = await collectEvents(store, threadId)
    const toolCompleted = completedToolItems(events)[0]
    expect(toolCompleted?.payload).toMatchObject({
      isError: true,
      content: 'Tool arguments were not valid JSON: {oops',
    })
    expect(
      llm.calls[1]?.bundle.messages.some(
        (message) => message.role === 'tool' && message.isError === true,
      ),
    ).toBe(true)
  })

  it('escalates the output-token cap and regenerates on max_tokens', async () => {
    const store = createStore()
    const llm = createFakeLlmRuntime({
      script: [
        { type: 'respond', deltas: ['trunc'], stopReason: 'max_tokens' },
        { type: 'respond', deltas: ['The full answer.'] },
      ],
      capabilities: { maxOutputTokens: 16384 },
    })
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({}),
      maxOutputTokens: 4096,
      now: () => NOW,
    })
    const threadId = crypto.randomUUID()
    const result = await loop.runTurn({ threadId, input: 'long answer' })
    expect(result.status).toBe('completed')
    if (result.status === 'completed') {
      expect(result.output).toBe('The full answer.')
    }
    // The truncated attempt doubled the cap for the regeneration.
    expect(llm.calls[0]?.options?.maxOutputTokens).toBe(4096)
    expect(llm.calls[1]?.options?.maxOutputTokens).toBe(8192)
    // The truncated assistant message never entered the model history.
    expect(
      llm.calls[1]?.bundle.messages.some(
        (message) => message.content === 'trunc',
      ),
    ).toBe(false)
  })

  it('fails with a clear error when the model maximum is already reached', async () => {
    const store = createStore()
    const llm = createFakeLlmRuntime({
      script: [{ type: 'respond', deltas: ['x'], stopReason: 'max_tokens' }],
    })
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({}),
      now: () => NOW,
    })
    const threadId = crypto.randomUUID()
    const result = await loop.runTurn({ threadId, input: 'x' })
    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.error).toMatch(/output token limit/)
    }
    // One attempt only: the cap already equals the model maximum.
    expect(llm.calls).toHaveLength(1)
  })

  it('waits between retries when the provider asks for backoff', async () => {
    const store = createStore()
    const llm = createFakeLlmRuntime({
      script: [
        {
          type: 'fail',
          error: {
            message: 'rate limited',
            retryability: 'retryable',
            retryAfterMs: 40,
          },
        },
        { type: 'respond', deltas: ['Recovered.'] },
      ],
    })
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({}),
      now: () => NOW,
    })
    const startedAt = Date.now()
    const result = await loop.runTurn({
      threadId: crypto.randomUUID(),
      input: 'x',
    })
    const elapsed = Date.now() - startedAt
    expect(result.status).toBe('completed')
    expect(elapsed).toBeGreaterThanOrEqual(35)
  })

  it('batches stream deltas into bounded Chronicle writes', async () => {
    const store = createStore()
    const pieces = Array.from({ length: 12 }, (_, index) => `chunk-${index}-`)
    const llm = createFakeLlmRuntime({
      script: [{ type: 'respond', deltas: pieces }],
    })
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({}),
      now: () => NOW,
    })
    const threadId = crypto.randomUUID()
    const result = await loop.runTurn({ threadId, input: 'long output' })
    expect(result.status).toBe('completed')
    const events = await collectEvents(store, threadId)
    const deltas = events.filter((event) => event.event === 'item.delta')
    // 12 * 9 = 108 chars; under the 256-char flush threshold the whole
    // message lands as one buffered delta.
    expect(deltas).toHaveLength(1)
    expect(deltas[0]?.delta).toBe(pieces.join(''))
  })

  it('fails the turn when the model fatally fails after retries', async () => {
    const store = createStore()
    const llm = createFakeLlmRuntime({
      script: [
        { type: 'fail', error: { message: 'boom', retryability: 'retryable' } },
        { type: 'fail', error: { message: 'boom', retryability: 'retryable' } },
        { type: 'fail', error: { message: 'boom', retryability: 'retryable' } },
      ],
    })
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({}),
      maxRetries: 2,
      retryDelayMs: 1,
      now: () => NOW,
    })
    const threadId = crypto.randomUUID()
    const result = await loop.runTurn({ threadId, input: 'x' })
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.error).toMatch(/boom/)
    expect(llm.calls).toHaveLength(3)
  })

  it('recovers from a retryable failure within the retry budget', async () => {
    const store = createStore()
    const llm = createFakeLlmRuntime({
      script: [
        {
          type: 'fail',
          error: { message: 'flaky', retryability: 'retryable' },
        },
        { type: 'respond', deltas: ['Recovered.'] },
      ],
    })
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({}),
      maxRetries: 2,
      retryDelayMs: 1,
      now: () => NOW,
    })
    const result = await loop.runTurn({
      threadId: crypto.randomUUID(),
      input: 'x',
    })
    expect(result.status).toBe('completed')
    expect(llm.calls).toHaveLength(2)
  })

  it('fails fast on context-overflow', async () => {
    const store = createStore()
    const llm = createFakeLlmRuntime({
      script: [
        {
          type: 'fail',
          error: { message: 'too big', retryability: 'context-overflow' },
        },
      ],
    })
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({}),
      now: () => NOW,
    })
    const result = await loop.runTurn({
      threadId: crypto.randomUUID(),
      input: 'x',
    })
    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.error).toMatch(/context overflow/)
    }
    expect(llm.calls).toHaveLength(1)
  })

  it('cancels the turn on an aborted signal', async () => {
    const store = createStore()
    const llm = createFakeLlmRuntime({
      script: [{ type: 'respond', deltas: ['slow'] }],
      stepDelayMs: 30,
    })
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({}),
      now: () => NOW,
    })
    const controller = new AbortController()
    const threadId = crypto.randomUUID()
    const running = loop.runTurn({
      threadId,
      input: 'x',
      signal: controller.signal,
    })
    controller.abort()
    const result = await running
    expect(result.status).toBe('cancelled')
    const events = await collectEvents(store, threadId)
    expect(events.at(-1)?.event).toBe('turn.cancelled')
  })
})

describe('AgentLoop crash recovery', () => {
  it('fails explicitly and records an event when a checkpoint digest drifts', async () => {
    const store = createStore()
    const threadId = crypto.randomUUID()
    const turn = newTurn({ threadId, trigger: 'user', input: 'go', now: NOW })
    const userItem = newItem({
      threadId,
      turnId: turn.id,
      type: 'message',
      payload: { role: 'user', content: 'go' },
      now: NOW,
    })
    await appendThreadEvents(store, threadId, [
      turnStartedEvent(turn),
      itemStartedEvent(userItem),
      itemCompletedEvent(userItem),
      agentCheckpointEvent(
        { threadId, turnId: turn.id },
        { stepIndex: 1, stateDigest: 'sha256:corrupt' },
      ),
    ])
    const llm = createFakeLlmRuntime({ script: [] })
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({}),
      now: () => NOW,
    })

    await expect(
      loop.recoverTurn({ threadId, turnId: turn.id }),
    ).rejects.toBeInstanceOf(CheckpointDigestMismatchError)
    const events = await collectEvents(store, threadId)
    expect(events.at(-1)?.event).toBe('agent.recovery_failed')
  })

  it('resumes from Chronicle and the last checkpoint after a crash', async () => {
    const store = createStore()
    const threadId = crypto.randomUUID()
    const turn = newTurn({ threadId, trigger: 'user', input: 'go', now: NOW })
    const userItem = newItem({
      threadId,
      turnId: turn.id,
      type: 'message',
      payload: { role: 'user', content: 'go' },
      now: NOW,
    })
    const assistantItem = newItem({
      threadId,
      turnId: turn.id,
      type: 'message',
      payload: { role: 'assistant', content: 'Working…' },
      now: NOW,
    })
    // Simulate a crash right after the first checkpoint: no turn.completed.
    await appendThreadEvents(store, threadId, [
      turnStartedEvent(turn),
      itemStartedEvent(userItem),
      itemCompletedEvent(userItem),
      itemStartedEvent(assistantItem),
      itemCompletedEvent(assistantItem),
      agentCheckpointEvent(
        { threadId, turnId: turn.id },
        {
          stepIndex: 1,
          stateDigest: historyDigest([
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'Working…' },
          ]),
        },
      ),
    ])

    // A fresh loop (new process) with a fresh LLM continues the turn.
    const llm = createFakeLlmRuntime({
      script: [{ type: 'respond', deltas: ['Recovered answer.'] }],
    })
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({}),
      now: () => NOW,
    })

    const result = await loop.recoverTurn({ threadId, turnId: turn.id })
    expect(result.status).toBe('completed')
    if (result.status === 'completed') {
      expect(result.output).toBe('Recovered answer.')
    }

    // The recovered turn rebuilt the committed history and resumed.
    const events = await collectEvents(store, threadId)
    expect(events.at(-1)?.event).toBe('turn.completed')
    expect(
      events.filter((event) => event.event === 'agent.checkpoint').length,
    ).toBeGreaterThanOrEqual(2)
  })

  it('recovers a crashed second turn with its carried thread prefix', async () => {
    const store = createStore()
    const threadId = crypto.randomUUID()

    // Turn 1 completes durably.
    const firstLlm = createFakeLlmRuntime({
      script: [{ type: 'respond', deltas: ['First answer.'] }],
    })
    const firstLoop = new AgentLoop({
      modelRequests: modelRequests(store, firstLlm),
      store,
      toolExecution: scriptedTools({}),
      now: () => NOW,
    })
    await firstLoop.runTurn({ threadId, input: 'first question' })

    // Turn 2 "crashes" after one checkpoint: turn.started, its user item,
    // one assistant item, and a checkpoint digest over carried + turn items.
    const now = NOW
    const turn = newTurn({ threadId, trigger: 'user', input: 'again', now })
    const userItem = newItem({
      threadId,
      turnId: turn.id,
      type: 'message',
      payload: { role: 'user', content: 'again' },
      now,
    })
    const assistantItem = newItem({
      threadId,
      turnId: turn.id,
      type: 'message',
      payload: { role: 'assistant', content: 'Working…' },
      now,
    })
    await appendThreadEvents(store, threadId, [
      turnStartedEvent(turn),
      itemStartedEvent(userItem),
      itemCompletedEvent(userItem),
      itemStartedEvent(assistantItem),
      itemCompletedEvent(assistantItem),
      agentCheckpointEvent(
        { threadId, turnId: turn.id },
        {
          stepIndex: 1,
          stateDigest: historyDigest([
            { role: 'user', content: 'first question' },
            { role: 'assistant', content: 'First answer.' },
            { role: 'user', content: 'again' },
            { role: 'assistant', content: 'Working…' },
          ]),
        },
      ),
    ])

    // A fresh loop recovers turn 2 and its next generation sees the whole
    // thread — the carried prefix plus turn 2's committed items.
    const llm = createFakeLlmRuntime({
      script: [{ type: 'respond', deltas: ['Recovered with memory.'] }],
    })
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({}),
      now: () => NOW,
    })
    const result = await loop.recoverTurn({ threadId, turnId: turn.id })
    expect(result.status).toBe('completed')
    expect(
      llm.calls[0]?.bundle.messages.map((message) => message.role),
    ).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  it('refuses to recover a terminal turn', async () => {
    const store = createStore()
    const threadId = crypto.randomUUID()
    const llm = createFakeLlmRuntime({
      script: [{ type: 'respond', deltas: ['done'] }],
    })
    const loop = new AgentLoop({
      modelRequests: modelRequests(store, llm),
      store,
      toolExecution: scriptedTools({}),
      now: () => NOW,
    })
    const result = await loop.runTurn({ threadId, input: 'x' })
    const turnId = result.turn.id

    await expect(loop.recoverTurn({ threadId, turnId })).rejects.toThrow(
      /not recoverable/,
    )
  })
})

describe('AgentLoop recovery of suspended turns', () => {
  it('recovers a suspended turn and resumes it after a crash', async () => {
    const store = createStore()
    const threadId = crypto.randomUUID()
    const firstLlm = createFakeLlmRuntime({
      script: [
        {
          type: 'respond',
          deltas: ['Deploy?'],
          toolCalls: [
            { callId: 'd1', toolId: 'deploy', input: { env: 'prod' } },
          ],
        },
      ],
    })
    const firstLoop = new AgentLoop({
      modelRequests: modelRequests(store, firstLlm),
      store,
      toolExecution: scriptedTools({
        deploy: () => ({
          kind: 'approval-required',
          approvalId: 'approval-1',
          title: 'Deploy to prod?',
        }),
      }),
      now: () => NOW,
    })
    const suspended = await firstLoop.runTurn({ threadId, input: 'Deploy' })
    expect(suspended.status).toBe('suspended')
    const turnId = suspended.turn.id

    // "Crash": a fresh loop resumes the suspended turn with a decision.
    const secondLlm = createFakeLlmRuntime({
      script: [{ type: 'respond', deltas: ['Deployed.'] }],
    })
    let approved = false
    const secondLoop = new AgentLoop({
      modelRequests: modelRequests(store, secondLlm),
      store,
      toolExecution: scriptedTools({
        deploy: () => {
          if (!approved) {
            return {
              kind: 'approval-required',
              approvalId: 'approval-1',
              title: 'Deploy to prod?',
            }
          }
          return { kind: 'result', output: { ok: true }, content: 'deployed' }
        },
      }),
      now: () => NOW,
    })
    approved = true
    const result = await secondLoop.resumeTurn({
      threadId,
      turnId,
      approvalId: 'approval-1',
      decision: 'approved',
    })
    expect(result.status).toBe('completed')
  })
})
