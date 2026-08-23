import type { AgentEvent, TaskState } from '@bee-agent/contracts'
import type { TaskSnapshot } from '@bee-agent/runtime'

/** View helpers mapping domain events and snapshots to display text. */

export function describeEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'task.created':
      return 'task created'
    case 'task.started':
      return 'task started'
    case 'task.suspended':
      return 'suspended, waiting for approval'
    case 'task.resumed': {
      const approved = (event.payload as { approved?: unknown }).approved
      return approved ? 'approved, task resumed' : 'denied, task resumed'
    }
    case 'task.completed':
      return 'task completed'
    case 'task.failed':
      return `task failed: ${String((event.payload as { error?: unknown }).error)}`
    case 'task.cancelled': {
      const reason = (event.payload as { reason?: unknown }).reason
      return reason === undefined
        ? 'task cancelled'
        : `task cancelled: ${String(reason)}`
    }
    case 'agent.message': {
      const payload = event.payload as { role?: unknown; content?: unknown }
      return `${String(payload.role ?? 'assistant')}: ${String(payload.content ?? '')}`
    }
    case 'tool.call': {
      const payload = event.payload as {
        call?: { toolId?: unknown; arguments?: unknown }
      }
      return `tool ${String(payload.call?.toolId)} ${JSON.stringify(payload.call?.arguments ?? {})}`
    }
    case 'tool.result': {
      const payload = event.payload as {
        result?: { error?: unknown; output?: unknown }
      }
      if (payload.result?.error !== undefined) {
        return `tool error: ${String(payload.result.error)}`
      }
      return `tool result: ${JSON.stringify(payload.result?.output)}`
    }
    case 'approval.requested': {
      const payload = event.payload as {
        request?: { risk?: unknown; reason?: unknown }
      }
      return `approval requested (${String(payload.request?.risk)}): ${String(payload.request?.reason)}`
    }
    case 'approval.decided': {
      const payload = event.payload as { decision?: { approved?: unknown } }
      return payload.decision?.approved ? 'approval granted' : 'approval denied'
    }
    default:
      return event.type
  }
}

/** One-line summary of a task for list rows. */
export function taskSummary(snapshot: TaskSnapshot): string {
  if (snapshot.error !== undefined) return snapshot.error
  if (snapshot.cancelReason !== undefined) return snapshot.cancelReason
  if (snapshot.spec) return snapshot.spec.input
  return ''
}

export const STATE_LABELS: Readonly<Record<TaskState, string>> = {
  pending: 'pending',
  running: 'running',
  waiting_approval: 'waiting',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
}

/** Terminal states close their SSE stream, so a finished feed is expected. */
export function isTerminalState(state: TaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled'
}
