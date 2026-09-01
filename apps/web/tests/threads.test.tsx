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
 * Conversation history (architecture §9.1): the bottom strip stays hidden
 * until the first conversation exists, then paginates every stored thread
 * and reopens one by replaying its item stream. Assistant messages render
 * their markdown instead of raw text.
 */
describe('thread history strip', () => {
  it('stays hidden with no history; 开启新对话 appears once threads exist', async () => {
    const client = {
      listThreads: vi.fn().mockResolvedValue([]),
      createThread: vi.fn(),
      streamItems: vi.fn(),
    } as unknown as BeeAgentClient
    render(<App client={client} />)

    await waitFor(() => {
      expect(client.listThreads).toHaveBeenCalled()
    })
    // Only the welcome CTA exists as an entry point.
    expect(screen.queryByText(/开启新对话/)).toBeNull()
    expect(screen.queryByRole('button', { name: /上一页/ })).toBeNull()
    expect(screen.getByRole('button', { name: /新建对话/ })).toBeDefined()

    cleanup()
    const withHistory = {
      listThreads: vi.fn().mockResolvedValue([summary()]),
      createThread: vi.fn(),
      streamItems: vi.fn(),
    } as unknown as BeeAgentClient
    render(<App client={withHistory} />)
    await waitFor(() => {
      expect(screen.getByText('旧会话')).toBeDefined()
    })
    expect(screen.getByRole('button', { name: /开启新对话/ })).toBeDefined()
  })

  it('paginates the thread list and reopens a thread on click', async () => {
    const opened: string[] = []
    const threads = Array.from({ length: 7 }, (_, index) =>
      summary({
        id: `55555555-5555-4555-8555-55555555555${index}`,
        title: `会话 ${index + 1}`,
        updatedAt: `2026-08-28T10:0${index}:00.000Z`,
      }),
    )
    const client = {
      listThreads: vi.fn().mockResolvedValue(threads),
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
      expect(screen.getByText('会话 1')).toBeDefined()
    })
    // Page one holds six of the seven threads.
    for (let index = 1; index <= 6; index += 1) {
      expect(screen.getByText(`会话 ${index}`)).toBeDefined()
    }
    expect(screen.queryByText('会话 7')).toBeNull()
    expect(screen.getByText('第 1/2 页')).toBeDefined()
    expect(
      (screen.getByRole('button', { name: /上一页/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /下一页/ }))
    await waitFor(() => {
      expect(screen.getByText('会话 7')).toBeDefined()
    })
    expect(screen.queryByText('会话 1')).toBeNull()
    expect(screen.getByText('第 2/2 页')).toBeDefined()
    expect(
      (screen.getByRole('button', { name: /下一页/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /会话 7/ }))
    await waitFor(() => {
      expect(opened).toEqual([threads[6]!.id])
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
