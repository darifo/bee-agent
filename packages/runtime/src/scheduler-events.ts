import { z } from 'zod'
import { newChronicleEvent } from '@bee-agent/knowledge'
import type { ChronicleActor, NewChronicleEvent } from '@bee-agent/knowledge'
import type { ChronicleSchemaRegistry } from '@bee-agent/knowledge'

/**
 * Scheduler Chronicle events (v1 refactor plan §5.5 WF4-F): durable
 * long-running state. Registered triggers, every fired run (with its
 * catch-up bookkeeping), and removals live on one serialized `scheduler`
 * stream, so a Host restart rebuilds the schedule and catches up missed
 * runs. Firing is at-least-once: a crash between the run and its event
 * replays the run — the thread's turn history keeps duplicates visible.
 */

export const SCHEDULER_STREAM_ID = 'scheduler'

export function schedulerStreamId(): string {
  return SCHEDULER_STREAM_ID
}

export const SchedulerTriggerSchema = z
  .object({
    id: z.uuid(),
    /** The turn input used for every run of this trigger. */
    input: z.string().min(1),
    /** The bound thread each run continues (threads run across days). */
    threadId: z.uuid(),
    /** First-run time; defaults to the registration instant. */
    at: z.iso.datetime().optional(),
    /** Recurrence interval; absent means a one-shot trigger. */
    intervalMs: z.number().int().positive().optional(),
    enabled: z.boolean(),
    createdAt: z.iso.datetime(),
    /** Next due time; absent when the trigger is exhausted or disabled. */
    nextRunAt: z.iso.datetime().optional(),
  })
  .strict()
export type SchedulerTrigger = z.infer<typeof SchedulerTriggerSchema>

export const SCHEDULER_EVENT_TYPES = [
  'scheduler.trigger.registered',
  'scheduler.trigger.triggered',
  'scheduler.trigger.removed',
] as const
export type SchedulerEventType = (typeof SCHEDULER_EVENT_TYPES)[number]

const TriggeredPayloadSchema = z.object({
  triggerId: z.uuid(),
  threadId: z.uuid(),
  turnId: z.uuid().optional(),
  status: z.enum(['completed', 'failed', 'cancelled', 'suspended', 'error']),
  firedAt: z.iso.datetime(),
  /** Fully missed intervals collapsed into this catch-up run. */
  missedIntervals: z.number().int().nonnegative(),
  nextRunAt: z.iso.datetime().optional(),
})

const SCHEDULER_EVENT_PAYLOADS: Record<
  SchedulerEventType,
  z.ZodType<unknown>
> = {
  'scheduler.trigger.registered': z.object({ trigger: SchedulerTriggerSchema }),
  'scheduler.trigger.triggered': TriggeredPayloadSchema,
  'scheduler.trigger.removed': z.object({
    triggerId: z.uuid(),
    reason: z.string().min(1).optional(),
  }),
}

export class UnknownSchedulerEventTypeError extends Error {
  constructor(readonly eventType: string) {
    super(`Event type '${eventType}' is not a scheduler event`)
    this.name = 'UnknownSchedulerEventTypeError'
  }
}

export function registerSchedulerChronicleEvents(
  registry: ChronicleSchemaRegistry,
): void {
  for (const [eventType, payload] of Object.entries(SCHEDULER_EVENT_PAYLOADS)) {
    registry.register(eventType, { payload: payload as never })
  }
}

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

export interface SchedulerEventBuildOptions {
  readonly actor?: ChronicleActor | undefined
}

const SCHEDULER_ACTOR: ChronicleActor = { type: 'system', id: 'bee-scheduler' }

function schedulerEvent(
  eventType: SchedulerEventType,
  scope: { threadId?: string | undefined },
  payload: unknown,
  options: SchedulerEventBuildOptions,
): NewChronicleEvent {
  return newChronicleEvent({
    eventType,
    actor: options.actor ?? SCHEDULER_ACTOR,
    ...(scope.threadId !== undefined ? { threadId: scope.threadId } : {}),
    payload,
  })
}

export function schedulerTriggerRegisteredEvent(
  trigger: SchedulerTrigger,
  options: SchedulerEventBuildOptions = {},
): NewChronicleEvent {
  return schedulerEvent(
    'scheduler.trigger.registered',
    { threadId: trigger.threadId },
    { trigger },
    options,
  )
}

export function schedulerTriggerTriggeredEvent(
  payload: z.infer<typeof TriggeredPayloadSchema>,
  options: SchedulerEventBuildOptions = {},
): NewChronicleEvent {
  return schedulerEvent(
    'scheduler.trigger.triggered',
    { threadId: payload.threadId },
    TriggeredPayloadSchema.parse(payload),
    options,
  )
}

export function schedulerTriggerRemovedEvent(
  input: {
    triggerId: string
    reason?: string | undefined
  },
  threadId: string | undefined,
  options: SchedulerEventBuildOptions = {},
): NewChronicleEvent {
  return schedulerEvent(
    'scheduler.trigger.removed',
    { threadId },
    {
      triggerId: input.triggerId,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    },
    options,
  )
}
