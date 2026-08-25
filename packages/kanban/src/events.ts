import { z } from 'zod'
import { newChronicleEvent } from '@bee-agent/knowledge'
import type {
  ChronicleActor,
  ChronicleEvent,
  ChronicleSchemaRegistry,
  ChronicleStore,
  NewChronicleEvent,
} from '@bee-agent/knowledge'
import {
  KanbanTaskIdSchema,
  KanbanTaskSchema,
  KanbanTaskStatusSchema,
} from './protocol.ts'
import type { KanbanTask, KanbanTaskId, KanbanTaskStatus } from './protocol.ts'

/**
 * Kanban tasks over Chronicle (architecture §15.2): each task is one stream,
 * its state transitions are durable events, and writes are guarded twice —
 * the aggregate `version` (state-machine) and the stream `sequence` (store).
 */

/** The Chronicle stream id holding one task's events. */
export function kanbanStreamId(taskId: KanbanTaskId): string {
  return `kanban:${taskId}`
}

export const KANBAN_TASK_EVENT_TYPES = [
  'kanban.task.created',
  'kanban.task.status_changed',
] as const
export type KanbanTaskEventType = (typeof KANBAN_TASK_EVENT_TYPES)[number]

const KanbanTaskCreatedPayloadSchema = z.object({
  task: KanbanTaskSchema,
})

/**
 * A state transition: the previous status, the resulting task (whose
 * `status` is `to` and whose `version` is one past the previous), and an
 * optional human-readable reason.
 */
const KanbanTaskStatusChangedPayloadSchema = z.object({
  from: KanbanTaskStatusSchema,
  to: KanbanTaskStatusSchema,
  reason: z.string().min(1).optional(),
  task: KanbanTaskSchema,
})

const KANBAN_TASK_EVENT_PAYLOADS: Record<
  KanbanTaskEventType,
  z.ZodType<unknown>
> = {
  'kanban.task.created': KanbanTaskCreatedPayloadSchema,
  'kanban.task.status_changed': KanbanTaskStatusChangedPayloadSchema,
}

/** Registers every kanban task event type on a Chronicle registry. */
export function registerKanbanChronicleEvents(
  registry: ChronicleSchemaRegistry,
): void {
  for (const [eventType, payload] of Object.entries(
    KANBAN_TASK_EVENT_PAYLOADS,
  )) {
    registry.register(eventType, { payload: payload as never })
  }
}

export class UnknownKanbanTaskEventTypeError extends Error {
  constructor(readonly eventType: string) {
    super(`Event type '${eventType}' is not a kanban task event`)
    this.name = 'UnknownKanbanTaskEventTypeError'
  }
}

const DEFAULT_ACTOR: ChronicleActor = { type: 'agent', id: 'bee' }

export interface KanbanEventBuildOptions {
  readonly actor?: ChronicleActor | undefined
}

export function kanbanTaskCreatedEvent(
  task: KanbanTask,
  options: KanbanEventBuildOptions = {},
): NewChronicleEvent {
  return newChronicleEvent({
    eventType: 'kanban.task.created',
    actor: options.actor ?? DEFAULT_ACTOR,
    taskId: task.id,
    payload: { task },
  })
}

export interface KanbanTaskStatusChangedInput {
  readonly from: KanbanTaskStatus
  /** The task after the transition; its `status` supplies `to`. */
  readonly task: KanbanTask
  readonly reason?: string | undefined
}

export function kanbanTaskStatusChangedEvent(
  input: KanbanTaskStatusChangedInput,
  options: KanbanEventBuildOptions = {},
): NewChronicleEvent {
  return newChronicleEvent({
    eventType: 'kanban.task.status_changed',
    actor: options.actor ?? DEFAULT_ACTOR,
    taskId: input.task.id,
    payload: {
      from: input.from,
      to: input.task.status,
      reason: input.reason,
      task: input.task,
    },
  })
}

/**
 * Appends built task events to the task's stream. `expectedSequence`
 * defaults to "after whatever is stored", correct for the single active
 * writer per task; concurrent writers surface the store's sequence conflict.
 */
export async function appendKanbanTaskEvents(
  store: ChronicleStore,
  taskId: KanbanTaskId,
  events: readonly NewChronicleEvent[],
): Promise<readonly ChronicleEvent[]> {
  const expectedSequence =
    (await store.getLatestSequence(kanbanStreamId(taskId))) + 1
  return store.append(kanbanStreamId(taskId), events, { expectedSequence })
}

/** Convenience: parses a stored event's task id, fail loud on malformed ids. */
export function kanbanTaskIdFromStream(streamId: string): KanbanTaskId {
  const prefix = 'kanban:'
  if (!streamId.startsWith(prefix)) {
    throw new Error(`Stream '${streamId}' is not a kanban task stream`)
  }
  return KanbanTaskIdSchema.parse(streamId.slice(prefix.length))
}
