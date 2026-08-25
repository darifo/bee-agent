import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type { BeeAgentClient, KanbanTaskDto } from '@bee-agent/client'
import { KanbanBoard } from '../src/KanbanBoard.tsx'

afterEach(cleanup)

const taskId = '0b6c6a68-8c5f-4d8f-9b52-1f2b1a2c3d4e'

function task(overrides: Partial<KanbanTaskDto> = {}): KanbanTaskDto {
  return {
    id: taskId,
    title: 'Write docs',
    status: 'inbox',
    priority: 'medium',
    labels: [],
    version: 1,
    createdAt: '2026-08-25T10:00:00.000Z',
    updatedAt: '2026-08-25T10:00:00.000Z',
    comments: [],
    ...overrides,
  }
}

function fakeClient(initial: KanbanTaskDto[] = []) {
  let tasks = [...initial]
  const created: string[] = []
  const completed: string[] = []
  const cancelled: string[] = []
  const client = {
    listTasks: async () => tasks,
    createTask: async (input: { title: string }) => {
      created.push(input.title)
      tasks = [...tasks, task({ title: input.title })]
      return task({ title: input.title })
    },
    completeTask: async (id: string) => {
      completed.push(id)
      tasks = tasks.map((t) => (t.id === id ? { ...t, status: 'done' } : t))
      return task({ status: 'done' })
    },
    cancelTask: async (id: string) => {
      cancelled.push(id)
      tasks = tasks.map((t) =>
        t.id === id ? { ...t, status: 'cancelled' } : t,
      )
      return task({ status: 'cancelled' })
    },
  }
  return {
    client: client as unknown as BeeAgentClient,
    created,
    completed,
    cancelled,
  }
}

describe('KanbanBoard', () => {
  it('lists tasks from the shared store', async () => {
    const { client } = fakeClient([
      task({ title: 'Ship it', status: 'running' }),
    ])
    render(<KanbanBoard client={client} />)
    expect(await screen.findByText('Ship it')).toBeDefined()
    expect(screen.getByText('running')).toBeDefined()
  })

  it('creates a task and refreshes the list', async () => {
    const { client, created } = fakeClient()
    render(<KanbanBoard client={client} />)

    const input = await screen.findByLabelText('task title')
    fireEvent.change(input, { target: { value: 'Write a report' } })
    fireEvent.click(screen.getByText('Create'))

    await waitFor(() => expect(created).toEqual(['Write a report']))
    expect(await screen.findByText('Write a report')).toBeDefined()
  })

  it('completes a task', async () => {
    const { client, completed } = fakeClient([
      task({ title: 'Ship it', status: 'running' }),
    ])
    render(<KanbanBoard client={client} />)

    fireEvent.click(await screen.findByText('Done'))
    await waitFor(() => expect(completed).toEqual([taskId]))
  })

  it('cancels a task', async () => {
    const { client, cancelled } = fakeClient([
      task({ title: 'Drop it', status: 'ready' }),
    ])
    render(<KanbanBoard client={client} />)

    fireEvent.click(await screen.findByText('Cancel'))
    await waitFor(() => expect(cancelled).toEqual([taskId]))
  })
})
