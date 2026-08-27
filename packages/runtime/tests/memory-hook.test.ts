import { describe, expect, it } from 'vitest'
import { ChronicleSchemaRegistry } from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import type {
  MemoryContext,
  MemoryDerivationInput,
  MemoryHealth,
  MemoryIngestInput,
  MemoryProvider,
  MemoryQuery,
} from '@bee-agent/knowledge'
import {
  appendThreadEvents,
  itemCompletedEvent,
  newItem,
  newTurn,
  registerThreadChronicleEvents,
  turnStartedEvent,
} from '@bee-agent/thread'
import { registerContextManifestChronicleEvents } from '@bee-agent/context'
import { registerMemoryChronicleEvents } from '@bee-agent/knowledge'
import { AgentLoop } from '../src/agent-loop.ts'
import {
  ModelRequestService,
  registerModelRequestChronicleEvents,
} from '../src/model-request-service.ts'
import { createFakeLlmRuntime } from '../src/testing.ts'
import {
  MemoryDerivationWorker,
  RememberingAgentLoop,
  createMemoryRetrieveHook,
} from '../src/memory-hook.ts'
import type { AgentLoopPort } from '../src/memory-hook.ts'
import type { AgentLoopTurnResult } from '../src/agent-loop.ts'
import type { ToolExecutionPort } from '../src/tool-execution.ts'

function createStore(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerThreadChronicleEvents(registry)
  registerContextManifestChronicleEvents(registry)
  registerModelRequestChronicleEvents(registry)
  registerMemoryChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

const noTools: ToolExecutionPort = {
  async execute() {
    throw new Error('no tools in this test')
  },
}

/** Scripted provider: records calls, answers from fixed fixtures. */
function scriptedProvider(fixtures: {
  readonly context?: MemoryContext | undefined
  readonly health?: MemoryHealth | undefined
  readonly derivedClaims?: number | undefined
}): {
  readonly provider: MemoryProvider
  readonly calls: {
    readonly queries: MemoryQuery[]
    readonly derivations: MemoryDerivationInput[]
    readonly ingests: MemoryIngestInput[]
  }
} {
  const queries: MemoryQuery[] = []
  const derivations: MemoryDerivationInput[] = []
  const ingests: MemoryIngestInput[] = []
  return {
    calls: { queries, derivations, ingests },
    provider: {
      async ingest(input) {
        ingests.push(input)
        return { claims: [], observations: [] }
      },
      async query(query) {
        queries.push(query)
        return []
      },
      async buildContext(input) {
        queries.push(input)
        return (
          fixtures.context ?? {
            content: '',
            claimIds: [],
            tokens: 0,
            omitted: 0,
          }
        )
      },
      async getRepresentation() {
        throw new Error('not used')
      },
      async derive(input) {
        derivations.push(input)
        return {
          claims: Array.from(
            { length: fixtures.derivedClaims ?? 0 },
            (_, index) => ({
              kind: 'preference' as const,
              statement: `derived ${index}`,
              subject: { type: 'user' as const },
              provenance: { streamId: 's', sequence: 1 },
            }),
          ),
          observations: [],
        }
      },
      async consolidate() {
        return { considered: 0, merged: [], at: '2026-01-01T00:00:00Z' }
      },
      async retract() {
        throw new Error('not used')
      },
      async export() {
        return {
          claims: [],
          observations: [],
          exportedAt: '2026-01-01T00:00:00Z',
        }
      },
      async health() {
        return fixtures.health ?? { status: 'healthy' }
      },
    },
  }
}

function completedResult(
  threadId: string,
  turnId: string,
): AgentLoopTurnResult {
  return {
    status: 'completed',
    output: 'done',
    turn: {
      id: turnId,
      threadId,
      status: 'completed',
      trigger: 'user',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:00:01Z',
    },
  }
}

describe('createMemoryRetrieveHook', () => {
  it('injects the recalled section into the model bundle', async () => {
    const store = createStore()
    const { provider, calls } = scriptedProvider({
      context: {
        content: '[preference] Prefer concise answers',
        claimIds: ['c1'],
        tokens: 8,
        omitted: 0,
      },
    })
    const llm = createFakeLlmRuntime({
      script: [{ type: 'respond', deltas: ['ok'] }],
    })
    const loop = new AgentLoop({
      store,
      modelRequests: new ModelRequestService({
        store,
        llm,
        promptVersion: 'test@1',
        structureVersion: 'sha256:test',
      }),
      toolExecution: noTools,
      hooks: { retrieve: createMemoryRetrieveHook(provider) },
    })

    const result = await loop.runTurn({
      threadId: crypto.randomUUID(),
      input: 'What layout do you like?',
    })
    expect(result.status).toBe('completed')

    const bundle = llm.calls[0]!.bundle
    const recalled = bundle.messages.find(
      (message) =>
        message.role === 'system' &&
        message.content.includes('Prefer concise answers'),
    )
    expect(recalled).toBeDefined()
    expect(recalled!.content).toContain('Recalled memory')
    expect(calls.queries[0]!.text).toBe('What layout do you like?')
    await store.close()
  })

  it('skips recall when the provider is unavailable', async () => {
    const store = createStore()
    const { provider, calls } = scriptedProvider({
      health: { status: 'unavailable' },
    })
    const llm = createFakeLlmRuntime({
      script: [{ type: 'respond', deltas: ['ok'] }],
    })
    const loop = new AgentLoop({
      store,
      modelRequests: new ModelRequestService({
        store,
        llm,
        promptVersion: 'test@1',
        structureVersion: 'sha256:test',
      }),
      toolExecution: noTools,
      hooks: { retrieve: createMemoryRetrieveHook(provider) },
    })

    await loop.runTurn({ threadId: crypto.randomUUID(), input: 'hello' })
    expect(calls.queries).toHaveLength(0)
    expect(
      llm.calls[0]!.bundle.messages.filter((m) => m.role === 'system'),
    ).toHaveLength(0)
    await store.close()
  })
})

describe('MemoryDerivationWorker', () => {
  it('feeds completed turn messages to the provider with provenance', async () => {
    const store = createStore()
    const { provider, calls } = scriptedProvider({ derivedClaims: 1 })

    const threadId = crypto.randomUUID()
    const turn = newTurn({ threadId, trigger: 'user', input: 'note this' })
    const userItem = newItem({
      threadId,
      turnId: turn.id,
      type: 'message',
      payload: { role: 'user', content: 'From now on, always answer briefly.' },
    })
    const assistantItem = newItem({
      threadId,
      turnId: turn.id,
      type: 'message',
      payload: { role: 'assistant', content: 'Understood.' },
    })
    await appendThreadEvents(store, threadId, [
      turnStartedEvent(turn),
      itemCompletedEvent(userItem),
      itemCompletedEvent(assistantItem),
    ])

    const worker = new MemoryDerivationWorker({ store, provider })
    const report = await worker.afterTurn({ threadId, turnId: turn.id })
    expect(report).toMatchObject({ derived: 1, recorded: 0, error: undefined })
    expect(calls.derivations).toHaveLength(1)
    expect(calls.derivations[0]!.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
    ])
    expect(calls.derivations[0]!.messages[0]!.provenance.streamId).toBe(
      `thread:${threadId}`,
    )
    expect(calls.derivations[0]!.messages[0]!.provenance.itemId).toBe(
      userItem.id,
    )
    expect(calls.ingests).toHaveLength(1)
    await store.close()
  })

  it('captures failures in the report instead of throwing', async () => {
    const store = createStore()
    const provider: MemoryProvider = {
      ...scriptedProvider({}).provider,
      async derive() {
        throw new Error('deriver exploded')
      },
    }
    const worker = new MemoryDerivationWorker({ store, provider })
    const report = await worker.afterTurn({
      threadId: crypto.randomUUID(),
      turnId: 'v1',
    })
    expect(report.error).toContain('deriver exploded')
    await store.close()
  })
})

describe('RememberingAgentLoop', () => {
  it('derives after completed turns but not suspended ones', async () => {
    const store = createStore()
    const { provider, calls } = scriptedProvider({})
    const worker = new MemoryDerivationWorker({ store, provider })

    const results: AgentLoopTurnResult[] = []
    const inner: AgentLoopPort = {
      async runTurn() {
        const result = completedResult('t1', 'v1')
        results.push(result)
        return result
      },
      async recoverTurn() {
        return completedResult('t1', 'v2')
      },
      async resumeTurn() {
        return {
          status: 'suspended',
          approval: { approvalId: 'a1', title: 'needs approval' },
          turn: {
            id: 'v3',
            threadId: 't1',
            status: 'active',
            trigger: 'user',
            startedAt: '2026-01-01T00:00:00Z',
          },
        }
      },
    }
    const loop = new RememberingAgentLoop(inner, worker)

    await loop.runTurn({ threadId: 't1', input: 'x' })
    await loop.resumeTurn({
      threadId: 't1',
      turnId: 'v3',
      approvalId: 'a1',
      decision: 'approved',
    })
    expect(calls.derivations).toHaveLength(1)
    await store.close()
  })

  it('keeps inner stop() semantics', async () => {
    const store = createStore()
    const { provider } = scriptedProvider({})
    let stopped = false
    const inner: AgentLoopPort & { stop(): void } = {
      async runTurn() {
        return completedResult('t1', 'v1')
      },
      async recoverTurn() {
        return completedResult('t1', 'v2')
      },
      async resumeTurn() {
        return completedResult('t1', 'v3')
      },
      stop: () => {
        stopped = true
      },
    }
    const loop = new RememberingAgentLoop(
      inner,
      new MemoryDerivationWorker({ store, provider }),
    )
    loop.stop()
    expect(stopped).toBe(true)
    await store.close()
  })
})
