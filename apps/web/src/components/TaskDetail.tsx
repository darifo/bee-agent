import type { ApprovalRequest, AgentEvent } from '@bee-agent/contracts'
import type { TaskSnapshot } from '@bee-agent/runtime'
import { StateBadge } from './StateBadge.tsx'
import { EventFeed } from './EventFeed.tsx'
import { ApprovalPanel } from './ApprovalPanel.tsx'

export interface TaskDetailProps {
  snapshot: TaskSnapshot
  events: readonly AgentEvent[]
  live: boolean
  /** Present while the task is suspended in `waiting_approval`. */
  pendingApproval: ApprovalRequest | undefined
  busy: boolean
  onDecide(requestId: string, approved: boolean, reason?: string): void
  onCancel(): void
}

/** Right-hand pane: snapshot header, approval controls, and the event feed. */
export function TaskDetail({
  snapshot,
  events,
  live,
  pendingApproval,
  busy,
  onDecide,
  onCancel,
}: TaskDetailProps) {
  const cancellable =
    snapshot.state === 'pending' ||
    snapshot.state === 'running' ||
    snapshot.state === 'waiting_approval'
  return (
    <section className="task-detail">
      <header className="task-detail-head">
        <StateBadge state={snapshot.state} />
        <span className="task-detail-input">
          {snapshot.spec?.input ?? snapshot.taskId}
        </span>
        <span className="task-detail-meta">
          {snapshot.spec?.agentId} · event #{snapshot.lastSequence}
        </span>
        {cancellable ? (
          <button
            type="button"
            className="cancel"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel task
          </button>
        ) : null}
      </header>
      {snapshot.error !== undefined ? (
        <p className="task-error">{snapshot.error}</p>
      ) : null}
      {snapshot.cancelReason !== undefined ? (
        <p className="task-error">cancelled: {snapshot.cancelReason}</p>
      ) : null}
      {pendingApproval ? (
        <ApprovalPanel
          request={pendingApproval}
          deciding={busy}
          onDecide={onDecide}
        />
      ) : null}
      <EventFeed events={events} live={live} />
    </section>
  )
}
