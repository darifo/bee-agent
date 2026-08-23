import type { AgentEvent } from '@bee-agent/contracts'
import type { TaskSnapshot } from '@bee-agent/runtime'
import { BeeAgentClientError } from '@bee-agent/client'

/** Renders task snapshots, stream events, and errors as plain text or JSON. */

export function printSnapshot(snapshot: TaskSnapshot, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(snapshot, null, 2))
    return
  }
  console.log(`task    ${snapshot.taskId}`)
  console.log(`state   ${snapshot.state}`)
  console.log(`events  ${snapshot.lastSequence}`)
  if (snapshot.spec) {
    console.log(`agent   ${snapshot.spec.agentId}`)
    console.log(`input   ${snapshot.spec.input}`)
  }
  if (snapshot.error !== undefined) console.log(`error   ${snapshot.error}`)
  if (snapshot.cancelReason !== undefined) {
    console.log(`reason  ${snapshot.cancelReason}`)
  }
  if (snapshot.pendingApprovalId !== undefined) {
    console.log(`approval pending: ${snapshot.pendingApprovalId}`)
  }
  if (snapshot.messages.length > 0) {
    console.log('messages:')
    for (const message of snapshot.messages) {
      console.log(`  ${message.role}> ${message.content}`)
    }
  }
  if (snapshot.result !== undefined) {
    console.log(`result  ${JSON.stringify(snapshot.result)}`)
  }
}

/** Prints one streamed task event; returns the state it implies, if any. */
export function printEvent(event: AgentEvent): string | undefined {
  switch (event.type) {
    case 'task.created':
      console.log(`[pending]    task ${event.taskId} created`)
      return 'pending'
    case 'task.started':
      console.log('[running]    task started')
      return 'running'
    case 'task.suspended': {
      const payload = event.payload as { approvalId?: unknown }
      console.log(
        `[waiting]    approval ${String(payload.approvalId)} required`,
      )
      console.log(
        '             decide with: bee approval decide <requestId> --approve|--deny',
      )
      return 'waiting_approval'
    }
    case 'task.resumed': {
      const payload = event.payload as { approved?: unknown }
      console.log(
        `[running]    ${payload.approved ? 'approved' : 'denied'}, task resumed`,
      )
      return 'running'
    }
    case 'agent.message': {
      const payload = event.payload as { role?: unknown; content?: unknown }
      console.log(
        `${String(payload.role ?? 'assistant')}> ${String(payload.content ?? '')}`,
      )
      return undefined
    }
    case 'tool.call': {
      const payload = event.payload as {
        call?: { toolId?: unknown; arguments?: unknown }
      }
      console.log(
        `  tool> ${String(payload.call?.toolId)} ${JSON.stringify(payload.call?.arguments ?? {})}`,
      )
      return undefined
    }
    case 'tool.result': {
      const payload = event.payload as {
        result?: { error?: unknown; output?: unknown }
      }
      if (payload.result?.error !== undefined) {
        console.log(`  tool! ${String(payload.result.error)}`)
      } else {
        console.log(`  tool= ${JSON.stringify(payload.result?.output)}`)
      }
      return undefined
    }
    case 'approval.requested': {
      const payload = event.payload as {
        request?: { id?: unknown; risk?: unknown; reason?: unknown }
      }
      console.log(
        `approval needed (${String(payload.request?.risk)}): ${String(payload.request?.reason)}`,
      )
      console.log(
        `  bee approval decide ${String(payload.request?.id)} --approve`,
      )
      return undefined
    }
    case 'approval.decided': {
      const payload = event.payload as {
        decision?: { approved?: unknown; reason?: unknown }
      }
      console.log(
        `approval ${payload.decision?.approved ? 'approved' : 'denied'}${
          payload.decision?.reason === undefined
            ? ''
            : `: ${String(payload.decision.reason)}`
        }`,
      )
      return undefined
    }
    case 'task.completed': {
      const payload = event.payload as { result?: unknown }
      console.log(`[completed]  ${JSON.stringify(payload.result)}`)
      return 'completed'
    }
    case 'task.failed': {
      const payload = event.payload as { error?: unknown }
      console.log(`[failed]     ${String(payload.error)}`)
      return 'failed'
    }
    case 'task.cancelled': {
      const payload = event.payload as { reason?: unknown }
      console.log(
        payload.reason === undefined
          ? '[cancelled]'
          : `[cancelled]  ${String(payload.reason)}`,
      )
      return 'cancelled'
    }
    default:
      console.log(`#${event.sequence} ${event.type}`)
      return undefined
  }
}

/** Exit code for a terminal task state. */
export function exitCodeFor(state: string): number {
  if (state === 'completed') return 0
  if (state === 'failed') return 1
  if (state === 'cancelled') return 2
  return 3
}

export function printError(error: unknown): void {
  if (error instanceof BeeAgentClientError) {
    console.error(
      `error [${error.code}] (HTTP ${error.status}): ${error.message}`,
    )
    return
  }
  console.error(error instanceof Error ? error.message : String(error))
}
