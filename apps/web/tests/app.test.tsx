import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type {
  AgentEvent,
  ApprovalRequest,
  TaskState,
} from '@bee-agent/contracts'
import type { CreateTaskResponse } from '@bee-agent/contracts'
import type { BeeAgentClient } from '@bee-agent/client'
import type { TaskSnapshot } from '@bee-agent/runtime'
import { App } from '../src/App.js'
import { ApprovalPanel } from '../src/components/ApprovalPanel.js'

afterEach(cleanup)

function snapshot(
  taskId: string,
  state: TaskState,
  input: string,
): TaskSnapshot {
  return {
    taskId,
    state,
    spec: {
      id: taskId,
      input,
      agentId: 'agent.mock',
      metadata: {},
    },
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    lastSequence: 1,
    result: undefined,
    error: undefined,
    cancelReason: undefined,
    pendingApprovalId: undefined,
    messages: [],
    toolCalls: [],
    toolResults: [],
    approvals: [],
    decisions: [],
  }
}

function agentEvent(
  taskId: string,
  sequence: number,
  type: string,
  payload: Record<string, unknown> = {},
): AgentEvent {
  return {
    id: `event-${taskId}-${sequence}`,
    taskId,
    sequence,
    type,
    payload,
    createdAt: '2026-08-23T00:00:00.000Z',
  }
}

const taskA = '11111111-1111-4111-8111-111111111111'
const taskB = '22222222-2222-4222-8222-222222222222'

interface ClientScript {
  tasks?: TaskSnapshot[]
  approvals?: ApprovalRequest[]
  events?: readonly AgentEvent[]
}

function fakeClient(script: ClientScript = {}) {
  const created: unknown[] = []
  const run: string[] = []
  const decisions: Array<{
    requestId: string
    approved: boolean
    reason?: string
  }> = []
  const client = {
    listTasks: async () => script.tasks ?? [],
    createTask: async (request: unknown) => {
      created.push(request)
      const response: CreateTaskResponse = {
        task: {
          id: taskA,
          input: 'typed input',
          agentId: 'agent.mock',
          metadata: {},
        },
        state: 'pending',
      }
      return response
    },
    runTask: async (taskId: string) => {
      run.push(taskId)
      return snapshot(taskId, 'running', 'typed input')
    },
    cancelTask: async (taskId: string) => snapshot(taskId, 'cancelled', 'x'),
    getTask: async (taskId: string) =>
      script.tasks?.find((task) => task.taskId === taskId) ??
      snapshot(taskId, 'completed', 'typed input'),
    listPendingApprovals: async () => script.approvals ?? [],
    resolveApproval: async (
      requestId: string,
      approved: boolean,
      reason?: string,
    ) => {
      decisions.push({
        requestId,
        approved,
        ...(reason !== undefined ? { reason } : {}),
      })
      return {
        requestId,
        approved,
        decidedAt: '2026-08-23T00:00:00.000Z',
      }
    },
    streamEvents: async function* (
      taskId: string,
    ): AsyncGenerator<AgentEvent, void, unknown> {
      for (const item of script.events ?? []) {
        yield item.taskId === taskId ? item : { ...item, taskId }
      }
    },
  }
  return {
    client: client as unknown as BeeAgentClient,
    created,
    run,
    decisions,
  }
}

function approvalFixture(taskId: string): ApprovalRequest {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    taskId,
    toolCall: {
      id: '44444444-4444-4444-8444-444444444444',
      taskId,
      toolId: 'tools.calculator',
      arguments: { expression: '1+1' },
    },
    reason: 'calculator is risky',
    risk: 'medium',
    createdAt: '2026-08-23T00:00:00.000Z',
  }
}

describe('App', () => {
  it('lists tasks and shows the selected task detail', async () => {
    const { client } = fakeClient({
      tasks: [
        snapshot(taskA, 'completed', 'first task'),
        snapshot(taskB, 'pending', 'second task'),
      ],
    })
    render(<App client={client} />)
    expect(await screen.findByText('first task')).toBeDefined()
    expect(screen.getByText('second task')).toBeDefined()
    fireEvent.click(screen.getByText('second task'))
    // the detail header shows the selected task's agent and event count
    expect(screen.getByText(/agent\.mock · event #1/)).toBeDefined()
  })

  it('creates a task, starts it, and streams its events', async () => {
    const script = fakeClient({
      events: [
        agentEvent(taskA, 1, 'task.created', { state: 'pending' }),
        agentEvent(taskA, 2, 'task.started', { state: 'running' }),
        agentEvent(taskA, 3, 'agent.message', {
          role: 'assistant',
          content: 'streamed hello',
        }),
        agentEvent(taskA, 4, 'task.completed', { state: 'completed' }),
      ],
    })
    render(<App client={script.client} />)
    const textarea = await screen.findByPlaceholderText(
      'What should the agent do?',
    )
    fireEvent.change(textarea, { target: { value: 'streamed input' } })
    fireEvent.click(screen.getByText('Create task'))
    await waitFor(() => {
      expect(script.created).toEqual([
        { input: 'streamed input', agentId: 'agent.mock', metadata: {} },
      ])
    })
    expect(script.run).toEqual([taskA])
    await waitFor(() => {
      expect(screen.getByText(/streamed hello/)).toBeDefined()
    })
    await waitFor(() => {
      expect(screen.getByText(/· closed/)).toBeDefined()
    })
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
  })

  it('decides pending approvals from the detail pane', async () => {
    const approval = approvalFixture(taskA)
    const script = fakeClient({
      tasks: [snapshot(taskA, 'waiting_approval', 'needs approval')],
      approvals: [approval],
      events: [
        agentEvent(taskA, 1, 'task.created', { state: 'pending' }),
        agentEvent(taskA, 2, 'task.suspended', {
          state: 'waiting_approval',
          approvalId: approval.id,
        }),
      ],
    })
    render(<App client={script.client} />)
    fireEvent.click(await screen.findByText('needs approval'))
    fireEvent.click(await screen.findByText('Approve'))
    await waitFor(() => {
      expect(script.decisions).toEqual([
        { requestId: approval.id, approved: true },
      ])
    })
  })
})

describe('ApprovalPanel', () => {
  it('passes the optional reason with the decision', async () => {
    const onDecide = vi.fn()
    render(
      <ApprovalPanel
        request={approvalFixture(taskA)}
        deciding={false}
        onDecide={onDecide}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText('optional reason'), {
      target: { value: ' looks fine ' },
    })
    fireEvent.click(screen.getByText('Deny'))
    expect(onDecide).toHaveBeenCalledWith(
      '33333333-3333-4333-8333-333333333333',
      false,
      'looks fine',
    )
  })
})
