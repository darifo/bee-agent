import { useCallback, useEffect, useState } from 'react'
import type { BeeAgentClient, ThreadSummaryDto } from '@bee-agent/client'

/** Threads per page in the bottom history strip. */
const PAGE_SIZE = 6

export interface ThreadHistoryProps {
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
 * Conversation history strip at the bottom of the chat view (architecture
 * §9.1): every thread the host stores, paginated, newest activity first.
 * Hidden entirely until the first conversation exists — the welcome CTA is
 * the only entry point then; once there is history, 开启新对话 joins the
 * bar. Reopening a thread replays its whole item history over the existing
 * SSE recovery path.
 */
export function ThreadHistory({
  client,
  activeThreadId,
  busy,
  refreshKey,
  onOpen,
  onNew,
}: ThreadHistoryProps) {
  const [threads, setThreads] = useState<readonly ThreadSummaryDto[]>([])
  const [page, setPage] = useState(0)
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

  // A refresh that follows a new thread lands it on the newest page.
  useEffect(() => {
    setPage(0)
  }, [refreshKey])

  // Zero-turn threads are clutter (abandoned 新建对话 clicks), so they are
  // filtered from the list — except the active one, which stays pinned
  // between creation and the first sent message.
  const visible = threads.filter(
    (thread) => thread.turns > 0 || thread.id === activeThreadId,
  )
  const hiddenEmptyCount = threads.length - visible.length

  if (visible.length === 0 && error === undefined) return null

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const items = visible.slice(
    safePage * PAGE_SIZE,
    safePage * PAGE_SIZE + PAGE_SIZE,
  )

  return (
    <footer className="thread-history" aria-label="历史会话">
      {error !== undefined ? (
        <p className="console-error" role="alert">
          {error}
        </p>
      ) : (
        <>
          <div className="history-bar">
            <span className="history-label">
              📚 历史会话（{visible.length}
              {hiddenEmptyCount > 0
                ? `，已隐藏 ${hiddenEmptyCount} 个空会话`
                : ''}
              ）
            </span>
            <div className="history-pager">
              <button
                type="button"
                onClick={() => setPage(Math.max(0, safePage - 1))}
                disabled={safePage === 0}
              >
                ‹ 上一页
              </button>
              <span className="history-page-no">
                第 {safePage + 1}/{pageCount} 页
              </span>
              <button
                type="button"
                onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
                disabled={safePage >= pageCount - 1}
              >
                下一页 ›
              </button>
            </div>
            <button
              type="button"
              className="history-new"
              onClick={onNew}
              disabled={busy}
            >
              ➕ 开启新对话
            </button>
          </div>
          <ul className="history-page">
            {items.map((thread) => (
              <li key={thread.id}>
                <button
                  type="button"
                  className={
                    thread.id === activeThreadId
                      ? 'history-item active'
                      : 'history-item'
                  }
                  onClick={() => onOpen(thread.id)}
                  aria-current={
                    thread.id === activeThreadId ? 'true' : undefined
                  }
                >
                  <span className="history-item-title">{thread.title}</span>
                  <span className="history-item-meta">
                    {relativeTime(thread.updatedAt)} · {thread.turns} 轮
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </footer>
  )
}
