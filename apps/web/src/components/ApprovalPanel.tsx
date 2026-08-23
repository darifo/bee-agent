import { useState } from 'react'
import type { ApprovalRequest } from '@bee-agent/contracts'

export interface ApprovalPanelProps {
  request: ApprovalRequest
  deciding: boolean
  onDecide(requestId: string, approved: boolean, reason?: string): void
}

/** Approve/deny controls for the task's pending approval request. */
export function ApprovalPanel({
  request,
  deciding,
  onDecide,
}: ApprovalPanelProps) {
  const [reason, setReason] = useState('')
  const trimmed = reason.trim()
  const decide = (approved: boolean) =>
    onDecide(request.id, approved, trimmed.length > 0 ? trimmed : undefined)
  return (
    <section className="approval-panel">
      <header>
        approval needed · {request.risk} risk
        <span className="approval-tool">{request.toolCall.toolId}</span>
      </header>
      <p>{request.reason}</p>
      <input
        value={reason}
        placeholder="optional reason"
        onChange={(change) => setReason(change.target.value)}
      />
      <div className="approval-actions">
        <button
          type="button"
          className="approve"
          disabled={deciding}
          onClick={() => decide(true)}
        >
          Approve
        </button>
        <button
          type="button"
          className="deny"
          disabled={deciding}
          onClick={() => decide(false)}
        >
          Deny
        </button>
      </div>
    </section>
  )
}
