import { describe, expect, it } from 'vitest'
import {
  ChronicleSchemaRegistry,
  newChronicleEvent,
} from '@bee-agent/knowledge'
import { registerThreadChronicleEvents } from '@bee-agent/thread'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import {
  ChronicleProposalStore,
  ExperimentNotAllowedError,
  ExperimentWorld,
  EvidenceVerifyEvaluator,
  changesetDigestOf,
  freezeDataset,
  registerLearningChronicleEvents,
} from '../src/index.ts'
import type { DerivedTurn, Evaluator } from '../src/index.ts'

function createStore(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerThreadChronicleEvents(registry)
  registerLearningChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

async function recordTurn(
  store: MemoryChronicleStore,
  input: {
    readonly toolCalls: readonly { toolId: string; isError?: boolean }[]
    readonly checkpoints?: number
  },
): Promise<{ threadId: string; turnId: string }> {
  const threadId = crypto.randomUUID()
  const turnId = crypto.randomUUID()
  const at = '2026-08-31T00:00:00.000Z'
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

function derived(
  turn: { threadId: string; turnId: string },
  toolCalls: { toolId: string; isError: boolean }[],
  checkpoints = 2,
): DerivedTurn {
  return {
    threadId: turn.threadId,
    turnId: turn.turnId,
    status: 'completed',
    checkpoints,
    toolCalls,
  }
}

describe('freezeDataset', () => {
  it('pins identical inputs to identical digests and moves with content', () => {
    const turn = derived(
      { threadId: crypto.randomUUID(), turnId: crypto.randomUUID() },
      [{ toolId: 'lookup', isError: false }],
    )
    const a = freezeDataset([turn], '2026-08-31T00:00:00Z')
    const b = freezeDataset([turn], '2026-08-31T09:00:00Z')
    expect(a.digest).toBe(b.digest)
    expect(a.digest).toMatch(/^sha256:[0-9a-f]{64}$/)

    const changed = freezeDataset(
      [{ ...turn, checkpoints: turn.checkpoints + 1 }],
      '2026-08-31T00:00:00Z',
    )
    expect(changed.digest).not.toBe(a.digest)
  })
})

describe('ExperimentWorld', () => {
  it('accepts proposals whose evidence the frozen data supports', async () => {
    const store = createStore()
    const proposals = new ChronicleProposalStore(store)
    await proposals.rebuild()
    const turn = await recordTurn(store, {
      toolCalls: [
        { toolId: 'lookup' },
        { toolId: 'lookup' },
        { toolId: 'lookup' },
      ],
    })
    const created = await proposals.create({
      type: 'skill',
      targetKey: 'skill:lookup',
      basedOnTrajectoryIds: [turn],
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
      now: '2026-08-31T00:00:00Z',
    })

    const world = new ExperimentWorld({ store, proposals })
    const report = await world.runForProposal(created.id)

    expect(report.verdict).toBe('accept')
    expect(report.metrics).toMatchObject({ verifiedUsage: 3, claimedUsage: 3 })
    expect(report.changesetDigest).toBe(changesetDigestOf(created))
    expect(report.rollback).toMatchObject({ kind: 'retract-skill' })
    expect(report.evaluatorId).toBe('evidence-verify@1')

    // The evidence gate moved the proposal into review, awaiting the user.
    const after = await proposals.get(created.id)
    expect(after?.status).toBe('review')

    // The report is durable and recoverable.
    const restarted = new ExperimentWorld({ store, proposals })
    await restarted.rebuild()
    expect(restarted.reportsFor(created.id)).toHaveLength(1)
    expect(restarted.reportsFor(created.id)[0]?.verdict).toBe('accept')
    await store.close()
  })

  it('archives proposals whose claims the frozen data refutes', async () => {
    const store = createStore()
    const proposals = new ChronicleProposalStore(store)
    await proposals.rebuild()
    const turn = await recordTurn(store, {
      toolCalls: [{ toolId: 'lookup' }, { toolId: 'lookup' }],
    })
    // The proposal claims 9 usages; the data holds 2.
    const created = await proposals.create({
      type: 'skill',
      targetKey: 'skill:lookup',
      basedOnTrajectoryIds: [turn],
      hypothesis: 'inflated claim',
      proposedChange: {
        kind: 'skill-candidate',
        toolId: 'lookup',
        usageCount: 9,
      },
      expectedBenefits: ['b'],
      risks: ['r'],
      evaluationPlan: 'e',
      rollbackPlan: 'rb',
      autonomyLevel: 2,
      now: '2026-08-31T00:00:00Z',
    })

    const world = new ExperimentWorld({ store, proposals })
    const report = await world.runForProposal(created.id)
    expect(report.verdict).toBe('reject')
    expect(report.metrics).toMatchObject({ verifiedUsage: 2, claimedUsage: 9 })
    expect(report.notes).toContain('the frozen data shows 2')

    // The evidence gate archives the proposal with the reason.
    const after = await proposals.get(created.id)
    expect(after?.status).toBe('rejected')
    await store.close()
  })

  it('refuses experiments outside draft/review and keeps failed evaluators recoverable', async () => {
    const store = createStore()
    const proposals = new ChronicleProposalStore(store)
    await proposals.rebuild()
    const turn = await recordTurn(store, { toolCalls: [{ toolId: 'x' }] })
    const created = await proposals.create({
      type: 'guardrail',
      targetKey: 'tool-failure:x',
      basedOnTrajectoryIds: [turn],
      hypothesis: 'h',
      proposedChange: {
        kind: 'failure-observation',
        toolId: 'x',
        failureCount: 5,
      },
      expectedBenefits: ['b'],
      risks: ['r'],
      evaluationPlan: 'e',
      rollbackPlan: 'rb',
      autonomyLevel: 0,
      now: '2026-08-31T00:00:00Z',
    })

    const throwing: Evaluator = {
      id: 'explode@1',
      async evaluate() {
        throw new Error('evaluator crashed')
      },
    }
    const world = new ExperimentWorld({
      store,
      proposals,
      evaluators: [throwing],
    })
    await expect(world.runForProposal(created.id)).rejects.toThrow(
      'evaluator crashed',
    )
    // The failure is durable...
    const types: string[] = []
    for await (const event of store.readStream('learning')) {
      types.push(event.eventType)
    }
    expect(types).toContain('learning.experiment.failed')
    // ...and the proposal stays in testing for a retry.
    expect((await proposals.get(created.id))?.status).toBe('testing')

    // Retrying from testing is refused; only draft/review can start.
    await expect(world.runForProposal(created.id)).rejects.toBeInstanceOf(
      ExperimentNotAllowedError,
    )
    await store.close()
  })

  it('verifies failure and long-turn claims via the default evaluator', async () => {
    const evaluator = new EvidenceVerifyEvaluator()
    const dataset = freezeDataset(
      [
        derived(
          { threadId: crypto.randomUUID(), turnId: crypto.randomUUID() },
          [
            { toolId: 'git', isError: true },
            { toolId: 'git', isError: true },
          ],
          7,
        ),
      ],
      '2026-08-31T00:00:00Z',
    )
    const base = {
      basedOnTrajectoryIds: [],
      expectedBenefits: ['b'],
      risks: ['r'],
      evaluationPlan: 'e',
      rollbackPlan: 'rb',
      origin: 'loop' as const,
      version: 1,
      createdAt: '2026-08-31T00:00:00Z',
      updatedAt: '2026-08-31T00:00:00Z',
    }
    const failureProposal = {
      ...base,
      id: crypto.randomUUID(),
      type: 'guardrail' as const,
      targetKey: 'tool-failure:git',
      hypothesis: 'h',
      proposedChange: {
        kind: 'failure-observation',
        toolId: 'git',
        failureCount: 2,
      },
      autonomyLevel: 0 as const,
      status: 'draft' as const,
    }
    const failure = await evaluator.evaluate({
      proposal: failureProposal as never,
      dataset,
    })
    expect(failure.verdict).toBe('accept')
    expect(failure.metrics).toMatchObject({ verifiedFailures: 2 })

    const longProposal = {
      ...base,
      id: crypto.randomUUID(),
      type: 'planning-policy' as const,
      targetKey: 'long-turns',
      hypothesis: 'h',
      proposedChange: { kind: 'long-turn-observation', turns: 1 },
      autonomyLevel: 0 as const,
      status: 'draft' as const,
    }
    const long = await evaluator.evaluate({
      proposal: longProposal as never,
      dataset,
    })
    expect(long.verdict).toBe('accept')
    expect(long.metrics).toMatchObject({ verifiedLongTurns: 1 })
  })
})
