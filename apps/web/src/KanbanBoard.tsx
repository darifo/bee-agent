import { useCallback, useEffect, useState } from 'react'
import type { BeeAgentClient, KanbanTaskDto } from '@bee-agent/client'

export interface KanbanBoardProps {
  client: BeeAgentClient
}

const TERMINAL = new Set(['done', 'cancelled', 'archived'])

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

/**
 * Kanban board view (architecture §15.1, v1 refactor plan §5.2 P2-9): reads
 * and writes the same store the conversation, CLI, and Scheduler use. The
 * board refreshes on mount, after every action, and on demand.
 */
export function KanbanBoard({ client }: KanbanBoardProps) {
  const [tasks, setTasks] = useState<KanbanTaskDto[]>([])
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

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

  return (
    <section className="board" aria-label="kanban board">
      <div className="task-form">
        <label>
          New task
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="新任务标题…"
            disabled={busy}
            aria-label="任务标题"
          />
        </label>
        <button
          type="button"
          onClick={() => void create()}
          disabled={busy || title.trim() === ''}
        >
          创建
        </button>
      </div>

      {error !== undefined ? <p className="console-error">{error}</p> : null}

      <ul className="task-list">
        {tasks.map((task) => (
          <li key={task.id} className="task-row">
            <div className="task-row-body">
              <span className="task-row-summary">{task.title}</span>
              <span className="task-row-meta">
                <span className={badgeClass(task.status)}>{task.status}</span>{' '}
                {task.priority}
              </span>
            </div>
            {!TERMINAL.has(task.status) ? (
              <>
                <button type="button" onClick={() => void complete(task.id)}>
                  完成
                </button>
                <button type="button" onClick={() => void cancel(task.id)}>
                  取消
                </button>
              </>
            ) : null}
          </li>
        ))}
      </ul>

      {tasks.length === 0 ? <p className="empty">还没有任务。</p> : null}

      <div className="board-actions">
        <button type="button" onClick={() => void refresh()} disabled={busy}>
          刷新
        </button>
      </div>
    </section>
  )
}
