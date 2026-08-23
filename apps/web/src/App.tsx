import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ApprovalRequest } from '@bee-agent/contracts'
import type { TaskSnapshot } from '@bee-agent/runtime'
import type { BeeAgentClient } from '@bee-agent/client'
import { TaskForm } from './components/TaskForm.js'
import { TaskList } from './components/TaskList.js'
import { TaskDetail } from './components/TaskDetail.js'
import { useTaskStream } from './hooks/useTaskStream.js'

export interface AppProps {
  client: BeeAgentClient
}

/**
 * Task console: create tasks, watch them execute over SSE, and decide
 * approvals. All server access goes through the Client SDK (ADR 0003).
 */
export function App({ client }: AppProps) {
  const [tasks, setTasks] = useState<readonly TaskSnapshot[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState<TaskSnapshot | undefined>()
  const [pendingApprovals, setPendingApprovals] = useState<
    readonly ApprovalRequest[]
  >([])

  const selected = useMemo(
    () => tasks.find((task) => task.taskId === selectedTaskId),
    [tasks, selectedTaskId],
  )
  const { events, live } = useTaskStream(client, selectedTaskId)

  const refresh = useCallback(async () => {
    try {
      const list = await client.listTasks()
      setTasks(list)
      setError(undefined)
      return list
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      return []
    }
  }, [client])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Snapshot and approvals refresh whenever new events arrive for the
  // selected task; the stream itself drives the detail pane.
  useEffect(() => {
    if (selectedTaskId === null || events.length === 0) return
    let cancelled = false
    void (async () => {
      try {
        const [snapshot, approvals] = await Promise.all([
          client.getTask(selectedTaskId),
          client.listPendingApprovals(selectedTaskId),
        ])
        if (cancelled) return
        setDetail(snapshot)
        setPendingApprovals(approvals)
      } catch {
        // transient refresh failures surface through the stream view
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, selectedTaskId, events.length])

  const createTask = useCallback(
    async (input: string, agentId: string) => {
      setBusy(true)
      try {
        const created = await client.createTask({
          input,
          agentId,
          metadata: {},
        })
        await client.runTask(created.task.id)
        setSelectedTaskId(created.task.id)
        await refresh()
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(false)
      }
    },
    [client, refresh],
  )

  const decide = useCallback(
    async (requestId: string, approved: boolean, reason?: string) => {
      setBusy(true)
      try {
        await client.resolveApproval(requestId, approved, reason)
        const approvals = await client.listPendingApprovals(
          selectedTaskId ?? undefined,
        )
        setPendingApprovals(approvals)
      } catch (reason_) {
        setError(reason_ instanceof Error ? reason_.message : String(reason_))
      } finally {
        setBusy(false)
      }
    },
    [client, selectedTaskId],
  )

  const cancel = useCallback(async () => {
    if (selectedTaskId === null) return
    setBusy(true)
    try {
      await client.cancelTask(selectedTaskId, 'cancelled from web')
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [client, refresh, selectedTaskId])

  const pendingApproval = useMemo(
    () => pendingApprovals.find((item) => item.taskId === selectedTaskId),
    [pendingApprovals, selectedTaskId],
  )
  const detailSnapshot = detail ?? selected

  return (
    <main className="console">
      <header className="console-head">
        <h1>Bee Agent</h1>
        <button
          type="button"
          className="refresh"
          onClick={() => void refresh()}
        >
          Refresh
        </button>
      </header>
      {error !== undefined ? <p className="console-error">{error}</p> : null}
      <div className="console-body">
        <aside className="console-side">
          <TaskForm disabled={busy} onCreate={createTask} />
          <TaskList
            tasks={tasks}
            selectedTaskId={selectedTaskId}
            onSelect={setSelectedTaskId}
          />
        </aside>
        {detailSnapshot ? (
          <TaskDetail
            snapshot={detailSnapshot}
            events={events}
            live={live}
            pendingApproval={pendingApproval}
            busy={busy}
            onDecide={decide}
            onCancel={cancel}
          />
        ) : (
          <section className="task-detail task-detail-empty">
            Select a task to see its live event stream.
          </section>
        )}
      </div>
    </main>
  )
}
