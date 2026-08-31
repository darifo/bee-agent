import { describe, expect, it } from 'vitest'
import {
  ChronicleSchemaRegistry,
  newChronicleEvent,
} from '@bee-agent/knowledge'
import { registerThreadChronicleEvents } from '@bee-agent/thread'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import {
  ChronicleProposalStore,
  DriftMonitor,
  deriveTurnsById,
  learningProposalActivatedEvent,
  registerLearningChronicleEvents,
} from '../src/index.ts'

function createStore(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerThreadChronicleEvents(registry)
  registerLearningChronicleEvents(registry)
  // The store stamps ingestTime with the same fake clock so `since`
  // windows order correctly against activation timestamps.
  return new MemoryChronicleStore(registry, { now: tick })
}

let clockMs = Date.parse('2026-08-31T00:00:00Z')
const tick = () =>
  new Date((clockMs += 1_000)).toISOString().replace(/\.\d{3}Z$/, '.000Z')

async function recordTurn(
  store: MemoryChronicleStore,
  input: {
    readonly toolCalls: readonly { toolId: string; isError?: boolean }[]
    readonly checkpoints?: number
  },
): Promise<{ threadId: string; turnId: string }> {
  const threadId = crypto.randomUUID()
  const turnId = crypto.randomUUID()
  const at = tick()
  const events = [
    newChronicleEvent({
      eventType: 'turn.started',
      actor: { type: 'agent', id: 'bee' },
      threadId,
      turnId,
      payload: {
        turn: {
          id: turnId,
          threadId,
          status: 'active',
          trigger: 'user',
          startedAt: at,
        },
      },
    }),
    ...input.toolCalls.map((call, index) =>
      newChronicleEvent({
        eventType: 'item.completed',
        actor: { type: 'agent', id: 'bee' },
        threadId,
        turnId,
        payload: {
          item: {
            id: crypto.randomUUID(),
            threadId,
            turnId,
            status: 'completed',
            type: 'tool_call',
            createdAt: at,
            payload: {
              toolId: call.toolId,
              callId: `c${index}`,
              input: {},
              ...(call.isError === undefined ? {} : { isError: call.isError }),
            },
          },
        },
      }),
    ),
    ...Array.from({ length: input.checkpoints ?? 1 }, (_, i) =>
      newChronicleEvent({
        eventType: 'agent.checkpoint',
        actor: { type: 'agent', id: 'bee' },
        threadId,
        turnId,
        payload: { stepIndex: i, stateDigest: `sha256:${i}` },
      }),
    ),
  ]
  await store.append(`thread:${threadId}`, events, { expectedSequence: 1 })
  return { threadId, turnId }
}

describe('deriveTurnsById', () => {
  it('reproduces immutable turns exactly by reference', async () => {
    const store = createStore()
    const turn = await recordTurn(store, {
      toolCalls: [{ toolId: 'a' }, { toolId: 'b', isError: true }],
      checkpoints: 4,
    })
    const derived = await deriveTurnsById(store, [turn])
    expect(derived).toHaveLength(1)
    expect(derived[0]).toMatchObject({
      threadId: turn.threadId,
      turnId: turn.turnId,
      checkpoints: 4,
    })
    expect(derived[0]!.toolCalls).toEqual([
      { toolId: 'a', isError: false },
      { toolId: 'b', isError: true },
    ])
    await store.close()
  })
})

describe('DriftMonitor', () => {
  async function promotedSetup(
    store: MemoryChronicleStore,
    proposals: ChronicleProposalStore,
    baselineTurn: { threadId: string; turnId: string },
  ) {
    const created = await proposals.create({
      type: 'skill',
      targetKey: 'skill:lookup',
      basedOnTrajectoryIds: [baselineTurn],
      hypothesis: 'h',
      proposedChange: {
        kind: 'skill-candidate',
        toolId: 'lookup',
        usageCount: 3,
      },
      expectedBenefits: ['b'],
      risks: ['r'],
      evaluationPlan: 'e',
      rollbackPlan: 'rb',
      autonomyLevel: 2,
      now: tick(),
    })
    // walk to promoted, then record the durable activation fact
    for (const to of ['review', 'trial', 'promoted'] as const) {
      const current = await proposals.get(created.id)
      await proposals.transition(created.id, {
        to,
        expectedVersion: current!.version,
      })
    }
    const activatedAt = tick()
    await store.append(
      'learning',
      [
        learningProposalActivatedEvent({
          proposalId: created.id,
          via: 'memory-claim',
          claimId: crypto.randomUUID(),
          activatedAt,
        }),
      ],
      { expectedSequence: (await store.getLatestSequence('learning')) + 1 },
    )
    return { proposalId: created.id, activatedAt }
  }

  it('rolls back automatically when post-adoption failures regress', async () => {
    const store = createStore()
    const proposals = new ChronicleProposalStore(store)
    await proposals.rebuild()
    const baseline = await recordTurn(store, {
      toolCalls: [
        { toolId: 'lookup' },
        { toolId: 'lookup' },
        { toolId: 'lookup' },
      ],
    })
    const { proposalId } = await promotedSetup(store, proposals, baseline)

    // Two new turns after adoption, both failing on the target tool.
    await recordTurn(store, {
      toolCalls: [
        { toolId: 'lookup', isError: true },
        { toolId: 'lookup', isError: true },
      ],
    })
    await recordTurn(store, {
      toolCalls: [{ toolId: 'lookup', isError: true }],
    })

    const monitor = new DriftMonitor({ store, proposals })
    const report = await monitor.check()
    expect(report.checked).toHaveLength(1)
    const check = report.checked[0]!
    expect(check.proposalId).toBe(proposalId)
    expect(check.metric).toBe('failure-rate:lookup')
    expect(check.verdict).toBe('regression')
    expect(check.rolledBack).toBe(true)
    expect(check.monitor).toBe(1)
    expect(check.baseline).toBe(0)

    const after = await proposals.get(proposalId)
    expect(after?.status).toBe('rolled-back')
    expect(after?.updatedAt).toBeTruthy()

    // The regression report is a durable fact.
    const types: string[] = []
    for await (const event of store.readStream('learning')) {
      types.push(event.eventType)
    }
    expect(types).toContain('learning.drift.checked')
    await store.close()
  })

  it('stays quiet on healthy windows and insufficient samples', async () => {
    const store = createStore()
    const proposals = new ChronicleProposalStore(store)
    await proposals.rebuild()
    const baseline = await recordTurn(store, {
      toolCalls: [
        { toolId: 'lookup' },
        { toolId: 'lookup' },
        { toolId: 'lookup' },
      ],
    })
    const { proposalId } = await promotedSetup(store, proposals, baseline)

    const cold = new DriftMonitor({ store, proposals })
    const noData = await cold.check()
    expect(noData.checked[0]!.verdict).toBe('insufficient-samples')
    expect((await proposals.get(proposalId))?.status).toBe('promoted')

    // Healthy post-adoption turns keep the proposal promoted.
    await recordTurn(store, { toolCalls: [{ toolId: 'lookup' }] })
    await recordTurn(store, { toolCalls: [{ toolId: 'lookup' }] })
    const healthy = await new DriftMonitor({ store, proposals }).check()
    expect(healthy.checked[0]!.verdict).toBe('ok')
    expect(healthy.checked[0]!.rolledBack).toBe(false)
    expect((await proposals.get(proposalId))?.status).toBe('promoted')
    await store.close()
  })
})
