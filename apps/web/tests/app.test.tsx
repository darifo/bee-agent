import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type { BeeAgentClient, TurnResult } from '@bee-agent/client'
import type { ThreadEvent, Turn } from '@bee-agent/thread'
import { App } from '../src/App.tsx'

afterEach(cleanup)

const threadId = '0b6c6a68-8c5f-4d8f-9b52-1f2b1a2c3d4e'
const turnId = '1c7d7b79-9d6f-5e9f-ac63-2f3c2b3d4e5f'

function turn(status: Turn['status']): Turn {
  return {
    id: turnId,
    threadId,
    status,
    trigger: 'user',
    startedAt: '2026-08-25T10:00:00.000Z',
  }
}

function threadFixture(): { id: string; title: string } {
  return { id: threadId, title: 'Web conversation' }
}

interface ClientScript {
  results?: TurnResult[]
  events?: readonly ThreadEvent[]
}

function fakeClient(script: ClientScript = {}) {
  const created: unknown[] = []
  const turns: Array<{ input: string }> = []
  const decisions: Array<{ approvalId: string; decision: string }> = []
  const resultQueue = [...(script.results ?? [])]
  const client = {
    createThread: async (input: unknown) => {
      created.push(input)
      return threadFixture()
    },
    createTurn: async (_threadId: string, input: { input: string }) => {
      turns.push(input)
      const next = resultQueue.shift()
      return (
        next ?? { status: 'completed', output: 'done', turn: turn('completed') }
      )
    },
    resolveApproval: async (
      _threadId: string,
      _turnId: string,
      approvalId: string,
      decision: 'approved' | 'rejected',
    ) => {
      decisions.push({ approvalId, decision })
      const next = resultQueue.shift()
      return (
        next ?? {
          status: 'completed',
          output: 'deployed',
          turn: turn('completed'),
        }
      )
    },
    streamItems: async function* (): AsyncGenerator<
      ThreadEvent,
      void,
      unknown
    > {
      for (const item of script.events ?? []) yield item
    },
  }
  return {
    client: client as unknown as BeeAgentClient,
    created,
    turns,
    decisions,
  }
}

describe('App', () => {
  it('starts a conversation and sends a message', async () => {
    const { client, created, turns } = fakeClient()
    render(<App client={client} />)
    fireEvent.click(screen.getByText('新建对话'))
    await waitFor(() => {
      expect(created).toEqual([{ title: 'Web conversation' }])
    })

    const input = await screen.findByPlaceholderText('给 Bee 发消息…')
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.click(screen.getByText('发送'))
    await waitFor(() => {
      expect(turns).toEqual([{ input: 'hello' }])
    })
    // The completed turn's output is not echoed into the transcript until
    // the stream emits it, so just assert the send went through.
  })

  it('surfaces a suspended turn as an approval prompt and decides it', async () => {
    const { client, decisions } = fakeClient({
      results: [
        {
          status: 'suspended',
          approval: { approvalId: 'approval-1', title: 'Deploy to prod?' },
          turn: turn('active'),
        },
        { status: 'completed', output: 'deployed', turn: turn('completed') },
      ],
    })
    render(<App client={client} />)
    fireEvent.click(screen.getByText('新建对话'))
    const input = await screen.findByPlaceholderText('给 Bee 发消息…')
    fireEvent.change(input, { target: { value: 'deploy' } })
    fireEvent.click(screen.getByText('发送'))

    expect(await screen.findByText(/Deploy to prod\?/)).toBeDefined()
    fireEvent.click(screen.getByText('批准'))
    await waitFor(() => {
      expect(decisions).toEqual([
        { approvalId: 'approval-1', decision: 'approved' },
      ])
    })
  })

  it('renders transcript entries from the item stream', async () => {
    const assistantItem = {
      id: '2d8e8c8a-ae70-4f0a-bd74-3a4d3c4e5f6a',
      threadId,
      turnId,
      status: 'completed',
      createdAt: '2026-08-25T10:00:00.000Z',
      type: 'message',
      payload: { role: 'assistant', content: 'streamed hello' },
    }
    const events: ThreadEvent[] = [
      {
        sequence: 1,
        threadId,
        turnId,
        event: 'item.completed',
        item: assistantItem as never,
      },
    ]
    const { client } = fakeClient({ events })
    render(<App client={client} />)
    fireEvent.click(screen.getByText('新建对话'))
    expect(await screen.findByText(/streamed hello/)).toBeDefined()
  })
})
