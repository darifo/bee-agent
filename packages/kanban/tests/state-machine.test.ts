import { describe, expect, it } from 'vitest'
import { KANBAN_TASK_STATUSES } from '../src/protocol.ts'
import type {
  KanbanClaimLease,
  KanbanTask,
  KanbanTaskStatus,
} from '../src/protocol.ts'
import {
  KANBAN_TERMINAL_STATUSES,
  KANBAN_TRANSITIONS,
  KanbanInvalidTransitionError,
  KanbanVersionConflictError,
  allowedTransitions,
  applyTransition,
  canTransition,
  isActive,
  isTerminal,
} from '../src/state-machine.ts'

const TASK_ID = '11111111-1111-4111-8111-111111111111'
const LEASE_ID = '44444444-4444-4444-8444-444444444444'
const NOW = '2026-08-25T10:00:00.000Z'
const LATER = '2026-08-25T11:00:00.000Z'

const claim: KanbanClaimLease = {
  claimant: 'worker-1',
  leaseId: LEASE_ID,
  claimedAt: NOW,
  expiresAt: LATER,
}

function taskFixture(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: TASK_ID,
    title: 'Refactor the store',
    goal: 'Ship it',
    acceptanceCriteria: ['tests pass'],
    priority: 'medium',
    labels: [],
    dependencies: [],
    requiredCapabilities: [],
    artifactRefs: [],
    trajectoryRefs: [],
    status: 'inbox',
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

describe('kanban transition table', () => {
  it('covers every status exactly once as a key', () => {
    expect(Object.keys(KANBAN_TRANSITIONS).sort()).toEqual(
      [...KANBAN_TASK_STATUSES].sort(),
    )
  })

  it('allows exactly the declared transitions', () => {
    for (const [from, tos] of Object.entries(KANBAN_TRANSITIONS)) {
      const status = from as KanbanTaskStatus
      expect(allowedTransitions(status)).toEqual(tos)
      for (const to of tos) {
        expect(canTransition(status, to)).toBe(true)
      }
      // No transition may loop back onto the same status.
      expect(canTransition(status, status)).toBe(false)
    }
  })

  it('lets every active state fail, cancel, or archive', () => {
    for (const status of KANBAN_TASK_STATUSES) {
      if (!isActive(status)) continue
      for (const to of ['failed', 'cancelled', 'archived'] as const) {
        expect(canTransition(status, to)).toBe(true)
      }
    }
  })

  it('walks the happy path inbox → triaged → ready → running → review → done', () => {
    const happyPath: KanbanTaskStatus[] = [
      'inbox',
      'triaged',
      'ready',
      'running',
      'review',
      'done',
    ]
    for (let index = 0; index < happyPath.length - 1; index += 1) {
      const from = happyPath[index]
      const to = happyPath[index + 1]
      expect(
        canTransition(from as KanbanTaskStatus, to as KanbanTaskStatus),
      ).toBe(true)
    }
  })

  it('allows retry and resume edges from blocked/failed', () => {
    expect(canTransition('blocked', 'running')).toBe(true)
    expect(canTransition('blocked', 'ready')).toBe(true)
    expect(canTransition('review', 'running')).toBe(true)
    expect(canTransition('failed', 'ready')).toBe(true)
    expect(canTransition('failed', 'running')).toBe(true)
  })

  it('archives terminal states and never leaves archived', () => {
    for (const from of ['done', 'failed', 'cancelled'] as const) {
      expect(canTransition(from, 'archived')).toBe(true)
    }
    expect(KANBAN_TRANSITIONS.archived).toEqual([])
    expect(canTransition('archived', 'done')).toBe(false)
  })
})

describe('terminal and active classification', () => {
  it('partitions the status set', () => {
    expect([...KANBAN_TERMINAL_STATUSES].sort()).toEqual(
      ['done', 'failed', 'cancelled', 'archived'].sort(),
    )
    const active = KANBAN_TASK_STATUSES.filter((status) => isActive(status))
    expect(active.sort()).toEqual(
      ['inbox', 'triaged', 'ready', 'running', 'blocked', 'review'].sort(),
    )
    for (const status of KANBAN_TASK_STATUSES) {
      expect(isTerminal(status)).toBe(!isActive(status))
    }
  })
})

describe('applyTransition', () => {
  it('advances status and version and stamps updatedAt', () => {
    const task = taskFixture({ status: 'ready', version: 3, updatedAt: NOW })
    const after = applyTransition(task, {
      to: 'running',
      expectedVersion: 3,
      at: LATER,
    })
    expect(after.status).toBe('running')
    expect(after.version).toBe(4)
    expect(after.updatedAt).toBe(LATER)
    expect(after.endedAt).toBeUndefined()
  })

  it('sets endedAt when entering a terminal state', () => {
    const task = taskFixture({ status: 'running', version: 2 })
    const after = applyTransition(task, {
      to: 'done',
      expectedVersion: 2,
      at: LATER,
    })
    expect(after.status).toBe('done')
    expect(after.endedAt).toBe(LATER)
    expect(after.version).toBe(3)
  })

  it('clears the claim lease when leaving running', () => {
    const task = taskFixture({ status: 'running', version: 5, claim })
    const after = applyTransition(task, {
      to: 'blocked',
      expectedVersion: 5,
      at: LATER,
    })
    expect(after.claim).toBeUndefined()
  })

  it('preserves the claim lease while staying running', () => {
    const task = taskFixture({ status: 'blocked', version: 1, claim })
    const after = applyTransition(task, {
      to: 'running',
      expectedVersion: 1,
      at: LATER,
    })
    expect(after.claim).toEqual(claim)
  })

  it('does not mutate its input', () => {
    const task = taskFixture({ status: 'ready', version: 1 })
    applyTransition(task, { to: 'running', expectedVersion: 1, at: LATER })
    expect(task.status).toBe('ready')
    expect(task.version).toBe(1)
  })

  it('rejects a concurrent transition whose expected version is stale', () => {
    const task = taskFixture({ status: 'ready', version: 2 })
    try {
      applyTransition(task, { to: 'running', expectedVersion: 1 })
      expect.unreachable('expected a version conflict')
    } catch (error) {
      expect(error).toBeInstanceOf(KanbanVersionConflictError)
      const conflict = error as KanbanVersionConflictError
      expect(conflict.taskId).toBe(TASK_ID)
      expect(conflict.expectedVersion).toBe(1)
      expect(conflict.actualVersion).toBe(2)
    }
  })

  it('rejects illegal transitions', () => {
    expect(() =>
      applyTransition(taskFixture({ status: 'inbox' }), {
        to: 'done',
        expectedVersion: 1,
      }),
    ).toThrow(KanbanInvalidTransitionError)
    expect(() =>
      applyTransition(taskFixture({ status: 'archived' }), {
        to: 'done',
        expectedVersion: 1,
      }),
    ).toThrow(KanbanInvalidTransitionError)
    expect(() =>
      applyTransition(taskFixture({ status: 'inbox' }), {
        to: 'inbox',
        expectedVersion: 1,
      }),
    ).toThrow(KanbanInvalidTransitionError)
  })
})
