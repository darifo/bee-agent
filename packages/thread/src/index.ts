import { z } from 'zod'
import { newChronicleEvent } from '@bee-agent/knowledge'
import type {
  ChronicleActor,
  ChronicleEvent,
  ChronicleStore,
  NewChronicleEvent,
} from '@bee-agent/knowledge'
import type { ChronicleSchemaRegistry } from '@bee-agent/knowledge'
import {
  AgentCheckpointEventSchema,
  AgentRecoveryFailedEventSchema,
  ContextCompactedEventSchema,
  TurnCancelledEventSchema,
  ItemDeltaEventSchema,
  ItemFailedEventSchema,
  ItemStartedEventSchema,
  ThreadCreatedEventSchema,
  ThreadEventSchema,
  TurnFailedEventSchema,
  TurnStartedEventSchema,
} from './protocol.ts'
import type {
  Item,
  ItemId,
  ItemPayloadMap,
  ItemType,
  Thread,
  ThreadEvent,
  ThreadEventPage,
  ThreadEventQuery,
  ThreadId,
  Turn,
  TurnId,
  TypedItem,
} from './protocol.ts'

export * from './protocol.ts'

/**
 * Thread–Turn–Item over Chronicle (v1 refactor plan §5.2 P1-8): every
 * thread is one Chronicle stream; the server assigns each wire event its
 * Chronicle sequence, and `after` recovery is a plain stream read. The
 * protocol types themselves stay dependency-free in
 * `@bee-agent/thread/protocol`; everything in this module is
 * host/runtime-facing.
 */

const DEFAULT_ACTOR: ChronicleActor = { type: 'agent', id: 'bee' }

/** The Chronicle stream id holding one thread's events. */
export function threadStreamId(threadId: ThreadId): string {
  return `thread:${threadId}`
}

export const THREAD_EVENT_TYPES = [
  'thread.created',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'item.started',
  'item.delta',
  'item.completed',
  'item.failed',
  'agent.checkpoint',
  'agent.recovery_failed',
  'context.compacted',
] as const
export type ThreadEventType = (typeof THREAD_EVENT_TYPES)[number]

/**
 * Payload schemas for the thread Chronicle event types. Each payload is the
 * corresponding wire event without position fields: `sequence` comes from
 * the stream, threadId/turnId ride the envelope scope.
 */
const ThreadCreatedPayloadSchema = z.object({
  thread: ThreadCreatedEventSchema.shape.thread,
})
const TurnPayloadSchema = z.object({
  turn: TurnStartedEventSchema.shape.turn,
})
const TurnFailedPayloadSchema = TurnFailedEventSchema.omit({
  sequence: true,
  threadId: true,
  turnId: true,
  event: true,
})
const TurnCancelledPayloadSchema = TurnCancelledEventSchema.omit({
  sequence: true,
  threadId: true,
  turnId: true,
  event: true,
})
const ItemPayloadSchema = z.object({
  item: ItemStartedEventSchema.shape.item,
})
const ItemDeltaPayloadSchema = ItemDeltaEventSchema.omit({
  sequence: true,
  threadId: true,
  turnId: true,
  event: true,
})
const ItemFailedPayloadSchema = ItemFailedEventSchema.omit({
  sequence: true,
  threadId: true,
  turnId: true,
  event: true,
})
const AgentCheckpointPayloadSchema = AgentCheckpointEventSchema.omit({
  sequence: true,
  threadId: true,
  turnId: true,
  event: true,
})
const AgentRecoveryFailedPayloadSchema = AgentRecoveryFailedEventSchema.omit({
  sequence: true,
  threadId: true,
  turnId: true,
  event: true,
})
const ContextCompactedPayloadSchema = ContextCompactedEventSchema.omit({
  sequence: true,
  threadId: true,
  turnId: true,
  event: true,
})

const THREAD_EVENT_PAYLOADS: Record<ThreadEventType, z.ZodType<unknown>> = {
  'thread.created': ThreadCreatedPayloadSchema,
  'turn.started': TurnPayloadSchema,
  'turn.completed': TurnPayloadSchema,
  'turn.failed': TurnFailedPayloadSchema,
  'turn.cancelled': TurnCancelledPayloadSchema,
  'item.started': ItemPayloadSchema,
  'item.delta': ItemDeltaPayloadSchema,
  'item.completed': ItemPayloadSchema,
  'item.failed': ItemFailedPayloadSchema,
  'agent.checkpoint': AgentCheckpointPayloadSchema,
  'agent.recovery_failed': AgentRecoveryFailedPayloadSchema,
  'context.compacted': ContextCompactedPayloadSchema,
}

/** Registers every thread event type on a Chronicle registry. */
export function registerThreadChronicleEvents(
  registry: ChronicleSchemaRegistry,
): void {
  for (const [eventType, payload] of Object.entries(THREAD_EVENT_PAYLOADS)) {
    registry.register(eventType, { payload: payload as never })
  }
}

export class UnknownThreadEventTypeError extends Error {
  constructor(readonly eventType: string) {
    super(`Event type '${eventType}' is not a thread event`)
    this.name = 'UnknownThreadEventTypeError'
  }
}

// ---------------------------------------------------------------------------
// Model constructors
// ---------------------------------------------------------------------------

export interface NewThreadInit {
  readonly title: string
  readonly workspaceId?: string | undefined
  readonly memoryView?: Thread['memoryView']
  readonly id?: ThreadId | undefined
  readonly now?: string | undefined
}

export function newThread(init: NewThreadInit): Thread {
  const now = init.now ?? new Date().toISOString()
  return ThreadCreatedEventSchema.shape.thread.parse({
    id: init.id ?? crypto.randomUUID(),
    title: init.title,
    workspaceId: init.workspaceId,
    memoryView: init.memoryView,
    createdAt: now,
    updatedAt: now,
  })
}

export interface NewTurnInit {
  readonly threadId: ThreadId
  readonly trigger: Turn['trigger']
  readonly input?: string | undefined
  readonly structureVersion?: string | undefined
  readonly id?: TurnId | undefined
  readonly now?: string | undefined
}

export function newTurn(init: NewTurnInit): Turn {
  return TurnStartedEventSchema.shape.turn.parse({
    id: init.id ?? crypto.randomUUID(),
    threadId: init.threadId,
    status: 'active',
    trigger: init.trigger,
    input: init.input,
    structureVersion: init.structureVersion,
    startedAt: init.now ?? new Date().toISOString(),
  })
}

export interface NewItemInit<T extends ItemType> {
  readonly threadId: ThreadId
  readonly turnId: TurnId
  readonly type: T
  readonly payload: ItemPayloadMap[T]
  readonly id?: ItemId | undefined
  readonly now?: string | undefined
}

export function newItem<T extends ItemType>(
  init: NewItemInit<T>,
): TypedItem<T> {
  return ItemStartedEventSchema.shape.item.parse({
    id: init.id ?? crypto.randomUUID(),
    threadId: init.threadId,
    turnId: init.turnId,
    status: 'active',
    createdAt: init.now ?? new Date().toISOString(),
    type: init.type,
    payload: init.payload,
  }) as TypedItem<T>
}

// ---------------------------------------------------------------------------
// Event builders (produce NewChronicleEvent, ready to append)
// ---------------------------------------------------------------------------

export interface ThreadEventBuildOptions {
  readonly actor?: ChronicleActor | undefined
}

function baseEvent(
  eventType: ThreadEventType,
  scope: { threadId: ThreadId; turnId?: TurnId | undefined },
  payload: unknown,
  options: ThreadEventBuildOptions,
): NewChronicleEvent {
  return newChronicleEvent({
    eventType,
    actor: options.actor ?? DEFAULT_ACTOR,
    threadId: scope.threadId,
    turnId: scope.turnId,
    payload,
  })
}

export function threadCreatedEvent(
  thread: Thread,
  options: ThreadEventBuildOptions = {},
): NewChronicleEvent {
  return baseEvent(
    'thread.created',
    { threadId: thread.id },
    { thread },
    options,
  )
}

export function turnStartedEvent(
  turn: Turn,
  options: ThreadEventBuildOptions = {},
): NewChronicleEvent {
  const event = baseEvent(
    'turn.started',
    { threadId: turn.threadId, turnId: turn.id },
    { turn },
    options,
  )
  return turn.structureVersion === undefined
    ? event
    : { ...event, structureVersion: turn.structureVersion }
}

export function turnCompletedEvent(
  turn: Turn,
  options: ThreadEventBuildOptions = {},
): NewChronicleEvent {
  return baseEvent(
    'turn.completed',
    { threadId: turn.threadId, turnId: turn.id },
    { turn },
    options,
  )
}

export function turnFailedEvent(
  turn: Turn,
  error: string,
  options: ThreadEventBuildOptions = {},
): NewChronicleEvent {
  return baseEvent(
    'turn.failed',
    { threadId: turn.threadId, turnId: turn.id },
    { turn, error },
    options,
  )
}

export function itemStartedEvent(
  item: Item,
  options: ThreadEventBuildOptions = {},
): NewChronicleEvent {
  return baseEvent(
    'item.started',
    { threadId: item.threadId, turnId: item.turnId },
    { item },
    options,
  )
}

export function itemDeltaEvent(
  ids: { threadId: ThreadId; turnId: TurnId; itemId: ItemId },
  delta: string,
  options: ThreadEventBuildOptions = {},
): NewChronicleEvent {
  return baseEvent(
    'item.delta',
    { threadId: ids.threadId, turnId: ids.turnId },
    { itemId: ids.itemId, delta },
    options,
  )
}

export function itemCompletedEvent(
  item: Item,
  options: ThreadEventBuildOptions = {},
): NewChronicleEvent {
  return baseEvent(
    'item.completed',
    { threadId: item.threadId, turnId: item.turnId },
    { item },
    options,
  )
}

export function turnCancelledEvent(
  turn: Turn,
  options: ThreadEventBuildOptions = {},
): NewChronicleEvent {
  return baseEvent(
    'turn.cancelled',
    { threadId: turn.threadId, turnId: turn.id },
    { turn },
    options,
  )
}

export function agentCheckpointEvent(
  ids: { threadId: ThreadId; turnId: TurnId },
  checkpoint: { stepIndex: number; stateDigest: string },
  options: ThreadEventBuildOptions = {},
): NewChronicleEvent {
  return baseEvent(
    'agent.checkpoint',
    { threadId: ids.threadId, turnId: ids.turnId },
    checkpoint,
    options,
  )
}

export function agentRecoveryFailedEvent(
  ids: { threadId: ThreadId; turnId: TurnId },
  failure: {
    checkpointSequence: number
    expectedDigest: string
    actualDigest: string
  },
  options: ThreadEventBuildOptions = {},
): NewChronicleEvent {
  return baseEvent('agent.recovery_failed', ids, failure, options)
}

export function contextCompactedEvent(
  ids: { threadId: ThreadId; turnId: TurnId },
  compaction: {
    summary: string
    coveredMessageCount: number
    coveredDigest: string
    coveredTokens: number
  },
  options: ThreadEventBuildOptions = {},
): NewChronicleEvent {
  return baseEvent(
    'context.compacted',
    ids,
    { ...compaction, reason: 'context-pressure' },
    options,
  )
}

export function itemFailedEvent(
  ids: { threadId: ThreadId; turnId: TurnId; itemId: ItemId },
  error: string,
  options: ThreadEventBuildOptions = {},
): NewChronicleEvent {
  return baseEvent(
    'item.failed',
    { threadId: ids.threadId, turnId: ids.turnId },
    { itemId: ids.itemId, error },
    options,
  )
}

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

/**
 * Appends built thread events to the thread's stream. `expectedSequence`
 * defaults to "after whatever is stored", which is correct for the single
 * active writer per thread (the AgentLoop); concurrent writers surface the
 * store's sequence conflict.
 */
export async function appendThreadEvents(
  store: ChronicleStore,
  threadId: ThreadId,
  events: readonly NewChronicleEvent[],
): Promise<readonly ChronicleEvent[]> {
  const expectedSequence =
    (await store.getLatestSequence(threadStreamId(threadId))) + 1
  return store.append(threadStreamId(threadId), events, { expectedSequence })
}

function toThreadEvent(stored: ChronicleEvent): ThreadEvent {
  if (!(THREAD_EVENT_TYPES as readonly string[]).includes(stored.eventType)) {
    throw new UnknownThreadEventTypeError(stored.eventType)
  }
  const { sequence, threadId, turnId } = stored
  const payload = stored.payload as Record<string, unknown>
  // The Chronicle event type maps one-to-one onto the wire discriminator;
  // `thread.created` carries no turn scope, everything else does.
  const candidate =
    stored.eventType === 'thread.created'
      ? { sequence, threadId, event: 'thread.created', ...payload }
      : { sequence, threadId, turnId, event: stored.eventType, ...payload }
  // The assembled wire event is the protocol contract boundary: parsing
  // here fails loud on malformed stream content instead of leaking
  // invalid events to clients.
  return ThreadEventSchema.parse(candidate)
}

/**
 * Converts one stored Chronicle event into its wire shape. Used by hosts
 * that stream live thread events (e.g. the apps/bee SSE endpoint) as they
 * are appended, without reading the whole stream back.
 */
export function threadEventFromChronicle(stored: ChronicleEvent): ThreadEvent {
  return toThreadEvent(stored)
}

/**
 * Reads a thread's history with `after` recovery semantics: returns wire
 * events with `sequence > after` in order, at most `limit` of them, with
 * `hasMore` telling the client to keep paging. Sequences are contiguous,
 * so a client that resumes from its last seen sequence cannot miss events.
 */
export async function readThreadEvents(
  store: ChronicleStore,
  threadId: ThreadId,
  query: ThreadEventQuery = {},
): Promise<ThreadEventPage> {
  const after = query.after ?? 0
  const events: ThreadEvent[] = []
  let hasMore = false
  for await (const stored of store.readStream(
    threadStreamId(threadId),
    after,
  )) {
    if (query.limit !== undefined && events.length === query.limit) {
      hasMore = true
      break
    }
    events.push(toThreadEvent(stored))
  }
  return { events, hasMore }
}

// ---------------------------------------------------------------------------
// Thread list projection
// ---------------------------------------------------------------------------

/** One thread as the conversation list shows it (architecture §9.1). */
export interface ThreadSummary {
  readonly id: ThreadId
  readonly title: string
  readonly createdAt: string
  /** Event time of the newest event in the thread's stream. */
  readonly updatedAt: string
  /** Number of turns started on the thread. */
  readonly turns: number
  /** Input of the most recent turn, clipped for list previews. */
  readonly lastInput: string | undefined
  /** Content of the most recent assistant message, clipped for previews. */
  readonly lastOutput: string | undefined
}

function clipPreview(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/**
 * Projects every stored thread into a list summary: title from the
 * `thread.created` fact, turn count from `turn.started`, and the newest
 * exchange plus last event time for ordering. The projection reads the
 * durable streams directly — nothing is cached, so the list is always the
 * truth, at personal-host scan cost.
 */
export async function listThreadSummaries(
  store: ChronicleStore,
): Promise<readonly ThreadSummary[]> {
  const summaries: ThreadSummary[] = []
  for (const streamId of await store.listStreams()) {
    if (!streamId.startsWith('thread:')) continue
    const threadId = streamId.slice('thread:'.length) as ThreadId
    let title = 'New thread'
    let createdAt = ''
    let updatedAt = ''
    let turns = 0
    let lastInput: string | undefined
    let lastOutput: string | undefined
    for await (const stored of store.readStream(streamId)) {
      updatedAt = stored.eventTime
      if (stored.eventType === 'thread.created') {
        const thread = (stored.payload as { thread?: Thread }).thread
        if (thread !== undefined) {
          title = thread.title
          createdAt = thread.createdAt
        }
      } else if (stored.eventType === 'turn.started') {
        turns += 1
        const turn = (stored.payload as { turn?: { input?: string } }).turn
        const input = turn?.input
        if (input !== undefined && input.trim() !== '') {
          lastInput = clipPreview(input)
        }
      } else if (stored.eventType === 'item.completed') {
        const item = (
          stored.payload as {
            item?: {
              type?: string
              payload?: { role?: string; content?: string }
            }
          }
        ).item
        if (
          item?.type === 'message' &&
          item.payload?.role === 'assistant' &&
          (item.payload.content ?? '').trim() !== ''
        ) {
          lastOutput = clipPreview(item.payload.content ?? '')
        }
      }
    }
    summaries.push({
      id: threadId,
      title,
      createdAt,
      updatedAt,
      turns,
      lastInput,
      lastOutput,
    })
  }
  return summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}
