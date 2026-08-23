import { z } from 'zod'
import {
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  TaskSpecSchema,
  ToolCallSchema,
  ToolResultSchema,
} from '@bee-agent/contracts'
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  TaskSpec,
  TaskState,
  ToolCall,
  ToolResult,
} from '@bee-agent/contracts'
import { assertTaskTransition } from './task-state-machine.js'

/**
 * Canonical task lifecycle event types. Every lifecycle payload carries the
 * resulting `state`, so a task snapshot is always derivable by folding the
 * event stream (ADR 0002).
 */
export const TASK_LIFECYCLE_EVENT_TYPES = [
  'task.created',
  'task.started',
  'task.suspended',
  'task.resumed',
  'task.completed',
  'task.failed',
  'task.cancelled',
] as const
export type TaskLifecycleEventType = (typeof TASK_LIFECYCLE_EVENT_TYPES)[number]

/** Event types the runtime itself produces; agents cannot emit them. */
export const RESERVED_EVENT_TYPES: readonly string[] = [
  ...TASK_LIFECYCLE_EVENT_TYPES,
  'approval.requested',
  'approval.decided',
  'tool.call',
  'tool.result',
]

export const TaskCreatedPayloadSchema = z.object({
  spec: TaskSpecSchema,
  state: z.literal('pending'),
})
export const TaskStartedPayloadSchema = z.object({
  state: z.literal('running'),
})
export const TaskSuspendedPayloadSchema = z.object({
  state: z.literal('waiting_approval'),
  approvalId: z.uuid(),
})
export const TaskResumedPayloadSchema = z.object({
  state: z.literal('running'),
  approvalId: z.uuid(),
  approved: z.boolean(),
})
export const TaskCompletedPayloadSchema = z.object({
  state: z.literal('completed'),
  // Optional-tolerant: JSON round trips drop `result` when the agent
  // returned no output.
  result: z.unknown().optional(),
})
export const TaskFailedPayloadSchema = z.object({
  state: z.literal('failed'),
  error: z.string().min(1),
})
export const TaskCancelledPayloadSchema = z.object({
  state: z.literal('cancelled'),
  reason: z.string().optional(),
})

export const AgentMessagePayloadSchema = z.object({
  role: z.string().min(1),
  content: z.string(),
})
export const ToolCallPayloadSchema = z.object({
  call: ToolCallSchema,
})
export const ToolResultPayloadSchema = z.object({
  result: ToolResultSchema,
})
export const ApprovalRequestedPayloadSchema = z.object({
  request: ApprovalRequestSchema,
})
export const ApprovalDecidedPayloadSchema = z.object({
  decision: ApprovalDecisionSchema,
})

export type TaskCreatedPayload = z.infer<typeof TaskCreatedPayloadSchema>
export type TaskStartedPayload = z.infer<typeof TaskStartedPayloadSchema>
export type TaskSuspendedPayload = z.infer<typeof TaskSuspendedPayloadSchema>
export type TaskResumedPayload = z.infer<typeof TaskResumedPayloadSchema>
export type TaskCompletedPayload = z.infer<typeof TaskCompletedPayloadSchema>
export type TaskFailedPayload = z.infer<typeof TaskFailedPayloadSchema>
export type TaskCancelledPayload = z.infer<typeof TaskCancelledPayloadSchema>
export type AgentMessagePayload = z.infer<typeof AgentMessagePayloadSchema>
export type ToolCallPayload = z.infer<typeof ToolCallPayloadSchema>
export type ToolResultPayload = z.infer<typeof ToolResultPayloadSchema>
export type ApprovalRequestedPayload = z.infer<
  typeof ApprovalRequestedPayloadSchema
>
export type ApprovalDecidedPayload = z.infer<
  typeof ApprovalDecidedPayloadSchema
>

export interface AgentMessage {
  readonly role: string
  readonly content: string
}

/** State rebuilt purely from a task's append-only event stream. */
export interface TaskSnapshot {
  readonly taskId: string
  readonly state: TaskState
  readonly spec: TaskSpec | undefined
  readonly createdAt: string | undefined
  readonly updatedAt: string | undefined
  readonly lastSequence: number
  readonly result: unknown
  readonly error: string | undefined
  readonly cancelReason: string | undefined
  /** Set while the task is suspended in `waiting_approval`. */
  readonly pendingApprovalId: string | undefined
  readonly messages: readonly AgentMessage[]
  readonly toolCalls: readonly ToolCall[]
  readonly toolResults: readonly ToolResult[]
  readonly approvals: readonly ApprovalRequest[]
  readonly decisions: readonly ApprovalDecision[]
}

export function initialTaskSnapshot(taskId: string): TaskSnapshot {
  return {
    taskId,
    state: 'pending',
    spec: undefined,
    createdAt: undefined,
    updatedAt: undefined,
    lastSequence: 0,
    result: undefined,
    error: undefined,
    cancelReason: undefined,
    pendingApprovalId: undefined,
    messages: [],
    toolCalls: [],
    toolResults: [],
    approvals: [],
    decisions: [],
  }
}

/**
 * Folds an entire task event stream into a snapshot. Unknown event types are
 * skipped (forward compatibility) while known types are validated strictly,
 * including lifecycle transition legality.
 */
export async function reduceTaskSnapshot(
  taskId: string,
  events: AsyncIterable<AgentEvent> | Iterable<AgentEvent>,
): Promise<TaskSnapshot> {
  let snapshot = initialTaskSnapshot(taskId)
  for await (const event of events) {
    snapshot = applyTaskEvent(snapshot, event)
  }
  return snapshot
}

export function applyTaskEvent(
  snapshot: TaskSnapshot,
  event: AgentEvent,
): TaskSnapshot {
  if (event.taskId !== snapshot.taskId) {
    throw new Error(
      `Event task '${event.taskId}' does not belong to task '${snapshot.taskId}'`,
    )
  }
  if (event.sequence !== snapshot.lastSequence + 1) {
    throw new Error(
      `Expected event sequence ${snapshot.lastSequence + 1} for task '${snapshot.taskId}' but got ${event.sequence}`,
    )
  }
  const base: TaskSnapshot = {
    ...snapshot,
    lastSequence: event.sequence,
    updatedAt: event.createdAt,
  }
  switch (event.type) {
    case 'task.created': {
      if (snapshot.lastSequence !== 0) {
        throw new Error(`task.created must be the first event of a task`)
      }
      const payload = TaskCreatedPayloadSchema.parse(event.payload)
      return { ...base, spec: payload.spec, createdAt: event.createdAt }
    }
    case 'task.started': {
      const payload = TaskStartedPayloadSchema.parse(event.payload)
      assertTaskTransition(snapshot.state, payload.state)
      return { ...base, state: payload.state }
    }
    case 'task.suspended': {
      const payload = TaskSuspendedPayloadSchema.parse(event.payload)
      assertTaskTransition(snapshot.state, payload.state)
      return {
        ...base,
        state: payload.state,
        pendingApprovalId: payload.approvalId,
      }
    }
    case 'task.resumed': {
      const payload = TaskResumedPayloadSchema.parse(event.payload)
      assertTaskTransition(snapshot.state, payload.state)
      return { ...base, state: payload.state, pendingApprovalId: undefined }
    }
    case 'task.completed': {
      const payload = TaskCompletedPayloadSchema.parse(event.payload)
      assertTaskTransition(snapshot.state, payload.state)
      return { ...base, state: payload.state, result: payload.result }
    }
    case 'task.failed': {
      const payload = TaskFailedPayloadSchema.parse(event.payload)
      assertTaskTransition(snapshot.state, payload.state)
      return { ...base, state: payload.state, error: payload.error }
    }
    case 'task.cancelled': {
      const payload = TaskCancelledPayloadSchema.parse(event.payload)
      assertTaskTransition(snapshot.state, payload.state)
      return {
        ...base,
        state: payload.state,
        cancelReason: payload.reason,
        pendingApprovalId: undefined,
      }
    }
    case 'agent.message': {
      const payload = AgentMessagePayloadSchema.parse(event.payload)
      return { ...base, messages: [...base.messages, payload] }
    }
    case 'tool.call': {
      const payload = ToolCallPayloadSchema.parse(event.payload)
      return { ...base, toolCalls: [...base.toolCalls, payload.call] }
    }
    case 'tool.result': {
      const payload = ToolResultPayloadSchema.parse(event.payload)
      return { ...base, toolResults: [...base.toolResults, payload.result] }
    }
    case 'approval.requested': {
      const payload = ApprovalRequestedPayloadSchema.parse(event.payload)
      return { ...base, approvals: [...base.approvals, payload.request] }
    }
    case 'approval.decided': {
      const payload = ApprovalDecidedPayloadSchema.parse(event.payload)
      return { ...base, decisions: [...base.decisions, payload.decision] }
    }
    default:
      return base
  }
}
