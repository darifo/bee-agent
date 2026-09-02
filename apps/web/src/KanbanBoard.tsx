import { useCallback, useEffect, useState } from 'react'
import type { BeeAgentClient, KanbanTaskDto } from '@bee-agent/client'

export interface KanbanBoardProps {
  client: BeeAgentClient
}

const TERMINAL = new Set(['done', 'cancelled', 'archived'])

const STATUS_LABELS: Record<string, string> = {
  inbox: '收件箱',
  triaged: '已分诊',
  ready: '就绪',
  running: '进行中',
  blocked: '受阻',
  review: '待复核',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  archived: '已归档',
}

const PRIORITY_LABELS: Record<string, string> = {
  urgent: '紧急',
  high: '高',
  medium: '中',
  low: '低',
  lowest: '最低',
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

function priorityLabel(priority: string): string {
  return PRIORITY_LABELS[priority] ?? priority
}

function badgeClass(status: string): string {
  if (status === 'running') return 'badge badge-running'
  if (status === 'blocked' || status === 'review') {
    return 'badge badge-waiting_approval'
  }
  if (status === 'done') return 'badge badge-completed'
  if (status === 'failed') return 'badge badge-failed'
  if (status === 'cancelled' || status === 'archived') {
    return 'badge badge-cancelled'
  }
  return 'badge badge-pending'
}

function priorityClass(priority: string): string {
  if (priority === 'urgent') return 'pri pri-urgent'
  if (priority === 'high') return 'pri pri-high'
  if (priority === 'low' || priority === 'lowest') return 'pri pri-low'
  return 'pri pri-medium'
}

/** The three lanes the board groups tasks into. */
const LANES: readonly {
  id: string
  title: string
  statuses: readonly string[]
  /** Drop target status — the transition endpoint walks the legal chain. */
  anchor: string
}[] = [
  {
    id: 'todo',
    title: '待办',
    statuses: ['inbox', 'triaged', 'ready'],
    anchor: 'ready',
  },
  {
    id: 'doing',
    title: '进行中',
    statuses: ['running', 'blocked', 'review'],
    anchor: 'running',
  },
  {
    id: 'done',
    title: '已完成',
    statuses: ['done', 'cancelled', 'archived', 'failed'],
    anchor: 'done',
  },
]

/**
 * Kanban board view (architecture §15.1, v1 refactor plan §5.2 P2-9): reads
 * and writes the same store the conversation, CLI, and Scheduler use.
 * Tasks group into three lanes; creating, completing, and cancelling stay
 * one click each.
 */
export function KanbanBoard({ client }: KanbanBoardProps) {
  const [tasks, setTasks] = useState<KanbanTaskDto[]>([])
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [detailId, setDetailId] = useState<string | undefined>()
  const [comment, setComment] = useState('')

  const refresh = useCallback(async () => {
    try {
      setTasks(await client.listTasks())
      setError(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [client])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const create = useCallback(async () => {
    if (title.trim() === '') return
    setBusy(true)
    setError(undefined)
    try {
      await client.createTask({ title: title.trim() })
      setTitle('')
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [client, title, refresh])

  const complete = useCallback(
    async (id: string) => {
      setBusy(true)
      setError(undefined)
      try {
        await client.completeTask(id)
        await refresh()
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(false)
      }
    },
    [client, refresh],
  )

  const moveTo = useCallback(
    async (id: string, to: string) => {
      setBusy(true)
      setError(undefined)
      try {
        await client.transitionTask(id, to, '拖拽移动')
        await refresh()
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(false)
      }
    },
    [client, refresh],
  )

  const cancel = useCallback(
    async (id: string) => {
      setBusy(true)
      setError(undefined)
      try {
        await client.cancelTask(id)
        await refresh()
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(false)
      }
    },
    [client, refresh],
  )

  const addComment = useCallback(async () => {
    if (detailId === undefined || comment.trim() === '') return
    setBusy(true)
    try {
      await client.commentTask(detailId, comment.trim(), '我')
      setComment('')
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [client, detailId, comment, refresh])

  return (
    <section className="board" aria-label="任务看板">
      <form
        className="kanban-composer"
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="要交给 Bee 的任务，例如：整理文档并归档…"
          disabled={busy}
          aria-label="任务标题"
        />
        <button type="submit" disabled={busy || title.trim() === ''}>
          ＋ 创建任务
        </button>
      </form>

      {error !== undefined ? <p className="console-error">{error}</p> : null}

      <div className="kanban-lanes">
        {LANES.map((lane) => {
          const laneTasks = tasks.filter((task) =>
            lane.statuses.includes(task.status),
          )
          return (
            <div key={lane.id} className="kanban-lane">
              <header className="kanban-lane-head">
                <h3>{lane.title}</h3>
                <span className="lane-count">{laneTasks.length}</span>
              </header>
              {laneTasks.length === 0 ? (
                <p className="lane-empty">暂无任务</p>
              ) : (
                <ul
                  className="lane-list"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault()
                    const id = event.dataTransfer.getData('text/task-id')
                    if (id !== '' && lane.anchor !== undefined) {
                      void moveTo(id, lane.anchor)
                    }
                  }}
                >
                  {laneTasks.map((task) => (
                    <li
                      key={task.id}
                      className="task-card"
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData('text/task-id', task.id)
                        event.dataTransfer.effectAllowed = 'move'
                      }}
                    >
                      <div className="task-card-top">
                        <span className={priorityClass(task.priority)}>
                          {priorityLabel(task.priority)}
                        </span>
                        <span className={badgeClass(task.status)}>
                          {statusLabel(task.status)}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="task-card-title"
                        onClick={() => setDetailId(task.id)}
                        title="查看任务详情"
                      >
                        {task.title}
                      </button>
                      {!TERMINAL.has(task.status) ? (
                        <div className="task-card-actions">
                          <button
                            type="button"
                            onClick={() => void complete(task.id)}
                            disabled={busy}
                          >
                            ✓ 完成
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => void cancel(task.id)}
                            disabled={busy}
                          >
                            取消
                          </button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
      </div>

      <div className="board-actions">
        <button
          type="button"
          className="ghost"
          onClick={() => void refresh()}
          disabled={busy}
        >
          ↻ 刷新
        </button>
      </div>

      {(() => {
        const detail = tasks.find((task) => task.id === detailId)
        if (detail === undefined) return null
        return (
          <div
            className="drawer-backdrop"
            role="presentation"
            onClick={() => setDetailId(undefined)}
          >
            <aside
              className="drawer"
              role="dialog"
              aria-label="任务详情"
              onClick={(event) => event.stopPropagation()}
            >
              <header className="drawer-head">
                <h3>{detail.title}</h3>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setDetailId(undefined)}
                >
                  ✕ 关闭
                </button>
              </header>
              <div className="drawer-body">
                <p className="drawer-meta">
                  <span className={badgeClass(detail.status)}>
                    {statusLabel(detail.status)}
                  </span>{' '}
                  <span className={priorityClass(detail.priority)}>
                    {priorityLabel(detail.priority)}
                  </span>{' '}
                  · v{detail.version} · 创建于{' '}
                  {detail.createdAt.slice(5, 16).replace('T', ' ')}
                </p>
                {detail.goal !== undefined && detail.goal !== '' ? (
                  <section>
                    <h4>目标</h4>
                    <p>{detail.goal}</p>
                  </section>
                ) : null}
                {detail.labels.length > 0 ? (
                  <section>
                    <h4>标签</h4>
                    <p className="drawer-chips">
                      {detail.labels.map((label) => (
                        <span key={label} className="chip">
                          {label}
                        </span>
                      ))}
                    </p>
                  </section>
                ) : null}
                <section>
                  <h4>评论（{detail.comments.length}）</h4>
                  {detail.comments.length === 0 ? (
                    <p className="empty">还没有评论。</p>
                  ) : (
                    <ul className="comment-list">
                      {detail.comments.map((entry) => (
                        <li key={entry.id}>
                          <span className="comment-author">{entry.author}</span>
                          <span className="comment-time">
                            {entry.at.slice(5, 16).replace('T', ' ')}
                          </span>
                          <p>{entry.body}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                  <form
                    className="comment-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void addComment()
                    }}
                  >
                    <input
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                      placeholder="添加评论…"
                      disabled={busy}
                      aria-label="评论内容"
                    />
                    <button
                      type="submit"
                      disabled={busy || comment.trim() === ''}
                    >
                      发表
                    </button>
                  </form>
                </section>
              </div>
            </aside>
          </div>
        )
      })()}
    </section>
  )
}
