import { useCallback, useEffect, useState } from 'react'
import type { BeeAgentClient, ThreadSummaryDto } from '@bee-agent/client'

export interface ThreadSidebarProps {
  client: BeeAgentClient
  readonly activeThreadId: string | null
  readonly busy: boolean
  /** Bumped by the parent after a thread is created or a turn settles. */
  readonly refreshKey: number
  readonly onOpen: (threadId: string) => void
  readonly onNew: () => void
}

function relativeTime(iso: string): string {
  const time = new Date(iso).getTime()
  if (Number.isNaN(time)) return ''
  const deltaMs = Date.now() - time
  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  const date = new Date(iso)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Conversation history rail (architecture §9.1): every thread the host
 * stores, newest activity first. Threads are durable Chronicle streams —
 * reopening one replays its whole item history over the existing SSE
 * recovery path, so this list is the only thing that was missing.
 */
export function ThreadSidebar({
  client,
  activeThreadId,
  busy,
  refreshKey,
  onOpen,
  onNew,
}: ThreadSidebarProps) {
  const [threads, setThreads] = useState<readonly ThreadSummaryDto[]>([])
  const [error, setError] = useState<string | undefined>()

  const refresh = useCallback(async () => {
    try {
      setThreads(await client.listThreads())
      setError(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [client])

  useEffect(() => {
    void refresh()
  }, [refresh, refreshKey])

  return (
    <aside className="thread-sidebar" aria-label="历史会话">
      <button
        type="button"
        className="sidebar-new"
        onClick={onNew}
        disabled={busy}
      >
        ➕ 开启新对话
      </button>
      {error !== undefined ? (
        <p className="console-error" role="alert">
          {error}
        </p>
      ) : null}
      {threads.length === 0 ? (
        <p className="sidebar-empty">还没有历史会话。</p>
      ) : (
        <ul className="thread-list">
          {threads.map((thread) => (
            <li key={thread.id}>
              <button
                type="button"
                className={
                  thread.id === activeThreadId
                    ? 'thread-item active'
                    : 'thread-item'
                }
                onClick={() => onOpen(thread.id)}
                aria-current={thread.id === activeThreadId ? 'true' : undefined}
              >
                <span className="thread-item-title">{thread.title}</span>
                <span className="thread-item-meta">
                  {relativeTime(thread.updatedAt)} · {thread.turns} 轮
                </span>
                <span className="thread-item-preview">
                  {thread.lastOutput ?? thread.lastInput ?? ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}
