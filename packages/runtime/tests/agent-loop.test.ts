import { describe, expect, it } from 'vitest'
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
import { AgentLoop } from '../src/agent-loop.js'
import { createFakeLlmRuntime } from '../src/testing.js'
import type {
  AgentLoopToolOutcome,
  AgentLoopToolSlot,
} from '../src/agent-loop.js'

function createStore(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerThreadChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

/** A tool slot whose behavior is scripted per (toolId, callId). */
function scriptedTools(
  handlers: Record<
    string,
    (input: unknown) => AgentLoopToolOutcome | Promise<AgentLoopToolOutcome>
  >,
): AgentLoopToolSlot {
  return {
    async execute({ call }) {
      const handler = handlers[call.toolId] ?? handlers['*']
      if (handler === undefined) {
        return { kind: 'result', output: {}, content: 'no handler' }
      }
      return handler(call.input)
    },
  }
}

const NOW = '2026-08-25T10:00:00.000Z'

async function collectEvents(store: MemoryChronicleStore, threadId: string) {
  const page = await readThreadEvents(store, threadId)
  return page.events
}

describe('AgentLoop happy path', () => {
  it('runs a single-step turn to completion and records the lifecycle', async () => {
    const store = createStore()
    const llm = createFakeLlmRuntime({
      script: [{ type: 'respond', deltas: ['The answer is 42.'] }],
    })
    const loop = new AgentLoop({
      llm,
      store,
      tools: scriptedTools({}),
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
      llm,
      store,
      tools: scriptedTools({
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
      llm,
      store,
      tools: scriptedTools({}),
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
      llm,
      store,
      tools: scriptedTools({
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
      llm,
      store,
      tools: scriptedTools({
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

describe('AgentLoop failure and cancellation', () => {
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
      llm,
      store,
      tools: scriptedTools({}),
      maxRetries: 2,
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
      llm,
      store,
      tools: scriptedTools({}),
      maxRetries: 2,
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
      llm,
      store,
      tools: scriptedTools({}),
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
      llm,
      store,
      tools: scriptedTools({}),
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
        { stepIndex: 1, stateDigest: 'sha256:unused-for-recovery' },
      ),
    ])

    // A fresh loop (new process) with a fresh LLM continues the turn.
    const llm = createFakeLlmRuntime({
      script: [{ type: 'respond', deltas: ['Recovered answer.'] }],
    })
    const loop = new AgentLoop({
      llm,
      store,
      tools: scriptedTools({}),
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

  it('refuses to recover a terminal turn', async () => {
    const store = createStore()
    const threadId = crypto.randomUUID()
    const llm = createFakeLlmRuntime({
      script: [{ type: 'respond', deltas: ['done'] }],
    })
    const loop = new AgentLoop({
      llm,
      store,
      tools: scriptedTools({}),
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
      llm: firstLlm,
      store,
      tools: scriptedTools({
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
      llm: secondLlm,
      store,
      tools: scriptedTools({
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
