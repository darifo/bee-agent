import { describe, expect, it } from 'vitest'
import {
  KANBAN_PRIORITIES,
  KANBAN_TASK_STATUSES,
  KanbanTaskSchema,
} from '../src/protocol.ts'

const TASK_ID = '11111111-1111-4111-8111-111111111111'
const THREAD_ID = '22222222-2222-4222-8222-222222222222'
const TURN_ID = '33333333-3333-4333-8333-333333333333'
const LEASE_ID = '44444444-4444-4444-8444-444444444444'
const NOW = '2026-08-25T10:00:00.000Z'

function taskFixture(overrides: Record<string, unknown> = {}) {
  return KanbanTaskSchema.parse({
    id: TASK_ID,
    title: 'Write the release notes',
    priority: 'medium',
    acceptanceCriteria: ['covers every change'],
    labels: [],
    dependencies: [],
    requiredCapabilities: [],
    status: 'inbox',
    artifactRefs: [],
    trajectoryRefs: [],
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  })
}

describe('KanbanTask contract', () => {
  it('exposes exactly the ten statuses of the architecture machine', () => {
    expect([...KANBAN_TASK_STATUSES]).toEqual([
      'inbox',
      'triaged',
      'ready',
      'running',
      'blocked',
      'review',
      'done',
      'failed',
      'cancelled',
      'archived',
    ])
    expect([...KANBAN_PRIORITIES]).toEqual([
      'lowest',
      'low',
      'medium',
      'high',
      'urgent',
    ])
  })

  it('round-trips a minimal inbox task with sensible defaults', () => {
    const task = taskFixture()
    expect(task.status).toBe('inbox')
    expect(task.version).toBe(1)
    expect(task.acceptanceCriteria).toEqual(['covers every change'])
    expect(task.labels).toEqual([])
    expect(task.dependencies).toEqual([])
    expect(task.artifactRefs).toEqual([])
    expect(task.trajectoryRefs).toEqual([])
    expect(task.claim).toBeUndefined()
    expect(task.endedAt).toBeUndefined()
  })

  it('round-trips the full field set from architecture §15.2', () => {
    const task = taskFixture({
      goal: 'Ship v1.2.0',
      acceptanceCriteria: ['release notes reviewed', 'changelog generated'],
      priority: 'high',
      labels: ['release', 'docs'],
      dependencies: [
        { taskId: TASK_ID, kind: 'blocks', satisfiedWhen: 'done' },
      ],
      source: { threadId: THREAD_ID, turnId: TURN_ID },
      workspace: { workspaceId: 'ws-1', path: '/notes' },
      requiredCapabilities: ['fs:write', 'network:http'],
      budget: { maxTokens: 10_000, maxCostCents: 5, maxDurationMs: 60_000 },
      scheduledAt: '2026-08-26T09:00:00.000Z',
      deadline: '2026-08-28T18:00:00.000Z',
      idempotencyKey: 'release-notes-v1.2.0',
      claim: {
        claimant: 'worker-1',
        leaseId: LEASE_ID,
        claimedAt: NOW,
        expiresAt: NOW,
      },
      artifactRefs: [{ id: 'sha256:abc', version: '1' }],
      trajectoryRefs: [{ id: 'episode-1', version: '1' }],
    })

    expect(task.goal).toBe('Ship v1.2.0')
    expect(task.priority).toBe('high')
    expect(task.dependencies).toEqual([
      { taskId: TASK_ID, kind: 'blocks', satisfiedWhen: 'done' },
    ])
    expect(task.source).toEqual({ threadId: THREAD_ID, turnId: TURN_ID })
    expect(task.workspace).toEqual({ workspaceId: 'ws-1', path: '/notes' })
    expect(task.budget).toEqual({
      maxTokens: 10_000,
      maxCostCents: 5,
      maxDurationMs: 60_000,
    })
    expect(task.idempotencyKey).toBe('release-notes-v1.2.0')
    expect(task.claim?.leaseId).toBe(LEASE_ID)
    expect(task.artifactRefs).toEqual([{ id: 'sha256:abc', version: '1' }])
    expect(task.trajectoryRefs).toEqual([{ id: 'episode-1', version: '1' }])
  })

  it('rejects malformed tasks', () => {
    expect(() => taskFixture({ title: '' })).toThrow()
    expect(() => taskFixture({ version: 0 })).toThrow()
    expect(() => taskFixture({ version: -1 })).toThrow()
    expect(() => taskFixture({ status: 'paused' })).toThrow()
    expect(() => taskFixture({ priority: 'super-urgent' })).toThrow()
    expect(() => taskFixture({ acceptanceCriteria: 'not-an-array' })).toThrow()
    expect(() => taskFixture({ createdAt: 'not-a-date' })).toThrow()
    expect(() =>
      taskFixture({
        dependencies: [{ taskId: 'not-a-uuid', kind: 'blocks' }],
      }),
    ).toThrow()
  })

  it('rejects a claim lease with invalid ids', () => {
    expect(() =>
      taskFixture({
        claim: {
          claimant: '',
          leaseId: 'not-a-uuid',
          claimedAt: NOW,
          expiresAt: NOW,
        },
      }),
    ).toThrow()
  })
})
