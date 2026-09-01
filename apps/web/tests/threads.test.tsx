import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type { BeeAgentClient, ThreadSummaryDto } from '@bee-agent/client'
import type { ThreadEvent } from '@bee-agent/thread/protocol'
import { App } from '../src/App.tsx'

afterEach(cleanup)

function summary(overrides: Partial<ThreadSummaryDto> = {}): ThreadSummaryDto {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: '旧会话',
    createdAt: '2026-08-28T10:00:00.000Z',
    updatedAt: '2026-08-28T10:05:00.000Z',
    turns: 3,
    lastInput: '列出目录内容',
    lastOutput: '文件夹：ai、工作',
    ...overrides,
  }
}

function assistantMessage(content: string): ThreadEvent {
  return {
    sequence: 3,
    threadId: '22222222-2222-4222-8222-222222222222',
    turnId: '33333333-3333-4333-8333-333333333333',
    event: 'item.completed',
    item: {
      id: '44444444-4444-4444-8444-444444444444',
      type: 'message',
      payload: { role: 'assistant', content },
    },
  } as unknown as ThreadEvent
}

/**
 * Conversation history (architecture §9.1): the sidebar lists every stored
 * thread and reopens one by replaying its item stream, and assistant
 * messages render their markdown instead of raw text.
 */
describe('thread history sidebar', () => {
  it('lists stored threads and reopens one on click', async () => {
    const opened: string[] = []
    const other = summary({
      id: '55555555-5555-4555-8555-555555555555',
      title: '整理文档',
    })
    const client = {
      listThreads: vi.fn().mockResolvedValue([other]),
      createThread: vi.fn(),
      streamItems: async function* (
        threadId: string,
      ): AsyncGenerator<ThreadEvent, void, unknown> {
        opened.push(threadId)
        yield* []
      },
    } as unknown as BeeAgentClient
    render(<App client={client} />)

    await waitFor(() => {
      expect(screen.getByText('整理文档')).toBeDefined()
    })
    expect(screen.getByText(/3 轮/)).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: /整理文档/ }))
    await waitFor(() => {
      expect(opened).toEqual([other.id])
    })
  })

  it('renders assistant markdown as formatted content', async () => {
    const client = {
      listThreads: vi.fn().mockResolvedValue([]),
      createThread: vi.fn().mockResolvedValue({
        id: '22222222-2222-4222-8222-222222222222',
        title: 'Web conversation',
      }),
      streamItems: async function* (): AsyncGenerator<
        ThreadEvent,
        void,
        unknown
      > {
        yield assistantMessage(
          '**要点**如下：\n\n- 第一项\n- 第二项\n\n`code_run` 已就绪。',
        )
      },
    } as unknown as BeeAgentClient
    render(<App client={client} />)
    fireEvent.click(screen.getByRole('button', { name: /新建对话/ }))

    await waitFor(() => {
      expect(screen.getByText('要点', { exact: false })).toBeDefined()
    })
    expect(screen.getByText('要点').tagName).toBe('STRONG')
    expect(screen.getByText('第一项').tagName).toBe('LI')
    expect(screen.getByText(/code_run/).tagName).toBe('CODE')
  })
})
