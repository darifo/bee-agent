import { describe, expect, it } from 'vitest'
import {
  ChronicleSchemaRegistry,
  newChronicleEvent,
} from '@bee-agent/knowledge'
import { registerThreadChronicleEvents } from '@bee-agent/thread'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import {
  ChronicleProposalStore,
  DEFAULT_LEARNING_BUDGET,
  InvalidProposalTransitionError,
  LearningLoop,
  ProposalVersionConflictError,
  canTransitionProposal,
  discoverPatterns,
  registerLearningChronicleEvents,
  selectAndDerive,
} from '../src/index.ts'
import type { DerivedTurn } from '../src/index.ts'

function createStore(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerThreadChronicleEvents(registry)
  registerLearningChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

function proposalStore(store: MemoryChronicleStore) {
  return new ChronicleProposalStore(store)
}

/**
 * Appends raw thread-shaped events (built through knowledge's envelope, so
 * learning keeps its narrow dependency boundary). Payloads follow the
 * thread package's registered schemas.
 */
async function recordTurn(
  store: MemoryChronicleStore,
  input: {
    readonly toolCalls: readonly { toolId: string; isError?: boolean }[]
    readonly checkpoints?: number
  },
): Promise<{ threadId: string; turnId: string }> {
  const threadId = crypto.randomUUID()
  const turnId = crypto.randomUUID()
  const at = '2026-08-29T00:00:00.000Z'
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

describe('proposal lifecycle', () => {
  it('follows the legal Proposal–Experiment–Trial–Rollback edges', () => {
    expect(canTransitionProposal('draft', 'review')).toBe(true)
    expect(canTransitionProposal('review', 'trial')).toBe(true)
    expect(canTransitionProposal('trial', 'promoted')).toBe(true)
    expect(canTransitionProposal('promoted', 'rolled-back')).toBe(true)
    expect(canTransitionProposal('draft', 'promoted')).toBe(false)
    expect(canTransitionProposal('rejected', 'review')).toBe(false)
    expect(canTransitionProposal('rolled-back', 'draft')).toBe(false)
  })

  it('creates, transitions with optimistic concurrency, and rebuilds', async () => {
    const store = createStore()
    const proposals = proposalStore(store)
    const created = await proposals.create({
      type: 'skill',
      targetKey: 'skill:lookup',
      basedOnTrajectoryIds: [],
      hypothesis: 'h',
      proposedChange: {},
      expectedBenefits: ['b'],
      risks: ['r'],
      evaluationPlan: 'e',
      rollbackPlan: 'rb',
      autonomyLevel: 2,
      now: '2026-08-29T00:00:00Z',
    })
    expect(created.status).toBe('draft')
    expect(created.version).toBe(1)

    await expect(
      proposals.transition(created.id, {
        to: 'promoted',
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(InvalidProposalTransitionError)
    await expect(
      proposals.transition(created.id, { to: 'review', expectedVersion: 99 }),
    ).rejects.toBeInstanceOf(ProposalVersionConflictError)

    const reviewed = await proposals.transition(created.id, {
      to: 'review',
      expectedVersion: 1,
      reason: 'evidence looks solid',
    })
    expect(reviewed.status).toBe('review')
    expect(reviewed.version).toBe(2)

    await proposals.transition(created.id, {
      to: 'trial',
      expectedVersion: 2,
    })
    const promoted = await proposals.transition(created.id, {
      to: 'promoted',
      expectedVersion: 3,
    })
    const rolledBack = await proposals.transition(promoted.id, {
      to: 'rolled-back',
      expectedVersion: 4,
      reason: 'regression observed',
    })
    expect(rolledBack.status).toBe('rolled-back')

    const restarted = proposalStore(store)
    await restarted.rebuild()
    const recovered = await restarted.get(created.id)
    expect(recovered?.status).toBe('rolled-back')
    expect(recovered?.version).toBe(5)
    await store.close()
  })
})

describe('selection and derivation', () => {
  it('derives tool-using turns with failure and step facts', async () => {
    const store = createStore()
    await recordTurn(store, {
      toolCalls: [
        { toolId: 'lookup' },
        { toolId: 'lookup' },
        { toolId: 'git', isError: true },
      ],
      checkpoints: 7,
    })
    await recordTurn(store, { toolCalls: [], checkpoints: 1 })
    await recordTurn(store, { toolCalls: [{ toolId: 'lookup' }] })

    const turns = await selectAndDerive(store, DEFAULT_LEARNING_BUDGET)
    // The tool-less turn is never selected.
    expect(turns).toHaveLength(2)
    const first = turns.find((t) => t.checkpoints === 7) as DerivedTurn
    expect(first.toolCalls).toEqual([
      { toolId: 'lookup', isError: false },
      { toolId: 'lookup', isError: false },
      { toolId: 'git', isError: true },
    ])
    await store.close()
  })
})

describe('pattern discovery', () => {
  const budget = DEFAULT_LEARNING_BUDGET

  it('proposes skills for frequent tools, guardrails for failures, and planning notes for long turns', () => {
    const turn = (toolId: string, isError: boolean): DerivedTurn => ({
      threadId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      status: 'completed',
      checkpoints: 2,
      toolCalls: [{ toolId, isError }],
    })
    const candidates = discoverPatterns(
      [
        turn('lookup', false),
        turn('lookup', false),
        turn('lookup', false),
        { ...turn('git', true), checkpoints: 7 },
        { ...turn('git', true), checkpoints: 7 },
      ],
      budget,
    )
    const skill = candidates.find((c) => c.targetKey === 'skill:lookup')
    expect(skill).toMatchObject({ type: 'skill', autonomyLevel: 2 })
    expect(skill!.basedOnTrajectoryIds).toHaveLength(3)
    const guardrail = candidates.find((c) => c.targetKey === 'tool-failure:git')
    expect(guardrail).toMatchObject({ type: 'guardrail', autonomyLevel: 0 })
    expect(candidates.some((c) => c.targetKey === 'long-turns')).toBe(true)
  })

  it('is deterministic for identical inputs', () => {
    const turns: DerivedTurn[] = [
      {
        threadId: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        status: 'completed',
        checkpoints: 2,
        toolCalls: [{ toolId: 'a', isError: false }],
      },
    ]
    expect(discoverPatterns(turns, budget)).toEqual(
      discoverPatterns(turns, budget),
    )
  })
})

describe('LearningLoop', () => {
  it('creates budgeted proposals, dedupes open targets, and records a durable run report', async () => {
    const store = createStore()
    const proposals = proposalStore(store)
    const loop = new LearningLoop({ store, proposals })
    await recordTurn(store, {
      toolCalls: [
        { toolId: 'lookup' },
        { toolId: 'lookup' },
        { toolId: 'lookup' },
      ],
    })

    const first = await loop.run()
    expect(first.selectedTrajectories).toBe(1)
    expect(first.proposalsCreated).toHaveLength(1)
    const created = await proposals.get(first.proposalsCreated[0]!)
    expect(created).toMatchObject({
      type: 'skill',
      targetKey: 'skill:lookup',
      status: 'draft',
      origin: 'loop',
      autonomyLevel: 2,
    })

    // The same evidence again: consolidation skips the open target.
    const second = await loop.run()
    expect(second.proposalsCreated).toHaveLength(0)
    expect(second.skippedDuplicates).toBe(1)

    // After rejection, the same signal can propose again.
    await proposals.transition(created!.id, {
      to: 'rejected',
      expectedVersion: 1,
      reason: 'not useful',
    })
    const third = await loop.run()
    expect(third.proposalsCreated).toHaveLength(1)

    // Every run left a durable audit fact on the learning stream.
    const runEvents: string[] = []
    for await (const event of store.readStream('learning')) {
      if (event.eventType === 'learning.loop.run')
        runEvents.push(event.eventType)
    }
    expect(runEvents).toHaveLength(3)
    await store.close()
  })

  it('caps proposals per run by budget', async () => {
    const store = createStore()
    const proposals = proposalStore(store)
    const loop = new LearningLoop({
      store,
      proposals,
      budget: { maxProposalsPerRun: 1 },
    })
    await recordTurn(store, {
      toolCalls: [
        { toolId: 'a' },
        { toolId: 'a' },
        { toolId: 'a' },
        { toolId: 'b', isError: true },
        { toolId: 'b', isError: true },
      ],
      checkpoints: 7,
    })
    const report = await loop.run()
    expect(report.proposalsCreated).toHaveLength(1)
    expect(report.patternsFound).toBeGreaterThanOrEqual(2)
    await store.close()
  })
})
