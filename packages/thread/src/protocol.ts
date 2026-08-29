import { z } from 'zod'

/**
 * The Thread–Turn–Item protocol (architecture §8.1): the one public
 * interaction contract every client consumes. This module deliberately
 * imports nothing but zod — no kernel, no cordis, no node builtins — so
 * browser and CLI clients can depend on `@bee-agent/thread/protocol`
 * alone. Everything runtime-facing (Chronicle wiring, store helpers) lives
 * in the package root.
 */

export const ThreadIdSchema = z.uuid()
export type ThreadId = z.infer<typeof ThreadIdSchema>

export const TurnIdSchema = z.uuid()
export type TurnId = z.infer<typeof TurnIdSchema>

export const ItemIdSchema = z.uuid()
export type ItemId = z.infer<typeof ItemIdSchema>

/** A pinned reference to another structure node (memory view, plan, ...). */
export const ProtocolRefSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
})
export type ProtocolRef = z.infer<typeof ProtocolRefSchema>

const IsoDateTime = z.iso.datetime()

/**
 * `Thread`: the long-lived, user-visible relationship. It owns a title, an
 * optional workspace, an optional memory view, and many turns.
 */
export const ThreadSchema = z.object({
  id: ThreadIdSchema,
  title: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  memoryView: ProtocolRefSchema.optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
})
export type Thread = z.infer<typeof ThreadSchema>

export const TurnStatusSchema = z.enum([
  'active',
  'completed',
  'failed',
  'cancelled',
])
export type TurnStatus = z.infer<typeof TurnStatusSchema>

export const TurnTriggerSchema = z.enum(['user', 'system', 'schedule'])

/**
 * `Turn`: one user input or system trigger through to a stable boundary
 * where control returns to the user (architecture §8.1).
 */
export const TurnSchema = z.object({
  id: TurnIdSchema,
  threadId: ThreadIdSchema,
  status: TurnStatusSchema,
  trigger: TurnTriggerSchema,
  /** The user-facing input that started the turn, when there was one. */
  input: z.string().optional(),
  /** Structure digest the turn is pinned to for reproducible replay. */
  structureVersion: z.string().min(1).optional(),
  startedAt: IsoDateTime,
  endedAt: IsoDateTime.optional(),
})
export type Turn = z.infer<typeof TurnSchema>

export const ItemStatusSchema = z.enum(['active', 'completed', 'failed'])
export type ItemStatus = z.infer<typeof ItemStatusSchema>

/**
 * Per-type item payloads. The architecture's item set: message, plan, tool
 * call, approval, artifact, file change, memory citation, learning note.
 */
export const MessageItemPayloadSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  toolCalls: z
    .array(
      z.object({
        callId: z.string().min(1),
        toolId: z.string().min(1),
        input: z.unknown(),
        /** Provider-detected malformed arguments; the call never ran. */
        inputError: z.string().optional(),
      }),
    )
    .optional(),
})
export type MessageItemPayload = z.infer<typeof MessageItemPayloadSchema>

export const PlanItemPayloadSchema = z.object({
  planId: z.string().min(1),
  version: z.string().min(1),
})
export type PlanItemPayload = z.infer<typeof PlanItemPayloadSchema>

export const ToolCallItemPayloadSchema = z.object({
  toolId: z.string().min(1),
  callId: z.string().min(1),
  input: z.unknown(),
  /** Provider-detected malformed arguments; the call never ran. */
  inputError: z.string().optional(),
  output: z.unknown().optional(),
  /** Exact model-visible tool result, retained for deterministic recovery. */
  content: z.string().optional(),
  isError: z.boolean().optional(),
})
export type ToolCallItemPayload = z.infer<typeof ToolCallItemPayloadSchema>

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'rejected'])

export const ApprovalItemPayloadSchema = z.object({
  title: z.string().min(1),
  detail: z.string().optional(),
  status: ApprovalStatusSchema,
  /** The tool-slot approval id, for resuming a suspended turn. */
  approvalId: z.string().min(1).optional(),
  /** Identifies the tool call awaiting this approval. */
  callId: z.string().min(1).optional(),
  toolId: z.string().min(1).optional(),
})
export type ApprovalItemPayload = z.infer<typeof ApprovalItemPayloadSchema>

export const ArtifactItemPayloadSchema = z.object({
  name: z.string().min(1).optional(),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
})
export type ArtifactItemPayload = z.infer<typeof ArtifactItemPayloadSchema>

export const FileChangeItemPayloadSchema = z.object({
  path: z.string().min(1),
  change: z.enum(['created', 'modified', 'deleted']),
  digest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .optional(),
})
export type FileChangeItemPayload = z.infer<typeof FileChangeItemPayloadSchema>

export const MemoryCitationItemPayloadSchema = z.object({
  memoryId: z.string().min(1),
  snippet: z.string(),
})
export type MemoryCitationItemPayload = z.infer<
  typeof MemoryCitationItemPayloadSchema
>

export const LearningNoteItemPayloadSchema = z.object({
  text: z.string().min(1),
})
export type LearningNoteItemPayload = z.infer<
  typeof LearningNoteItemPayloadSchema
>

export const ITEM_TYPES = [
  'message',
  'plan',
  'tool_call',
  'approval',
  'artifact',
  'file_change',
  'memory_citation',
  'learning_note',
] as const
export type ItemType = (typeof ITEM_TYPES)[number]

const ItemCoreSchema = z.object({
  id: ItemIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  status: ItemStatusSchema,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime.optional(),
  endedAt: IsoDateTime.optional(),
  error: z.string().optional(),
})

/**
 * `Item`: a streamable, persistable unit of work inside a turn. The
 * discriminated union pairs every `type` with exactly its payload shape, so
 * a mismatched payload fails validation instead of leaking through.
 */
export const ItemSchema = z.discriminatedUnion('type', [
  ItemCoreSchema.extend({
    type: z.literal('message'),
    payload: MessageItemPayloadSchema,
  }),
  ItemCoreSchema.extend({
    type: z.literal('plan'),
    payload: PlanItemPayloadSchema,
  }),
  ItemCoreSchema.extend({
    type: z.literal('tool_call'),
    payload: ToolCallItemPayloadSchema,
  }),
  ItemCoreSchema.extend({
    type: z.literal('approval'),
    payload: ApprovalItemPayloadSchema,
  }),
  ItemCoreSchema.extend({
    type: z.literal('artifact'),
    payload: ArtifactItemPayloadSchema,
  }),
  ItemCoreSchema.extend({
    type: z.literal('file_change'),
    payload: FileChangeItemPayloadSchema,
  }),
  ItemCoreSchema.extend({
    type: z.literal('memory_citation'),
    payload: MemoryCitationItemPayloadSchema,
  }),
  ItemCoreSchema.extend({
    type: z.literal('learning_note'),
    payload: LearningNoteItemPayloadSchema,
  }),
])
export type Item = z.infer<typeof ItemSchema>

export type TypedItem<T extends ItemType> = Extract<Item, { type: T }>

/** Payload type per item type, for typed constructors on the runtime side. */
export interface ItemPayloadMap {
  message: MessageItemPayload
  plan: PlanItemPayload
  tool_call: ToolCallItemPayload
  approval: ApprovalItemPayload
  artifact: ArtifactItemPayload
  file_change: FileChangeItemPayload
  memory_citation: MemoryCitationItemPayload
  learning_note: LearningNoteItemPayload
}

/**
 * Lifecycle and boundary events on a thread, the shape clients stream and
 * paginate. `sequence` is the event's position inside its thread: assigned
 * by the server from the Chronicle stream, contiguous from 1, and the only
 * cursor a reconnecting client needs (`after = last seen sequence`).
 */
const EventPositionSchema = z.object({
  sequence: z.number().int().positive(),
  threadId: ThreadIdSchema,
})

const TurnEventPositionSchema = EventPositionSchema.extend({
  turnId: TurnIdSchema,
})

export const ThreadCreatedEventSchema = EventPositionSchema.extend({
  event: z.literal('thread.created'),
  thread: ThreadSchema,
})
export type ThreadCreatedEvent = z.infer<typeof ThreadCreatedEventSchema>

export const TurnStartedEventSchema = TurnEventPositionSchema.extend({
  event: z.literal('turn.started'),
  turn: TurnSchema,
})
export type TurnStartedEvent = z.infer<typeof TurnStartedEventSchema>

export const TurnCompletedEventSchema = TurnEventPositionSchema.extend({
  event: z.literal('turn.completed'),
  turn: TurnSchema,
})
export type TurnCompletedEvent = z.infer<typeof TurnCompletedEventSchema>

export const TurnFailedEventSchema = TurnEventPositionSchema.extend({
  event: z.literal('turn.failed'),
  error: z.string().min(1),
  turn: TurnSchema,
})
export type TurnFailedEvent = z.infer<typeof TurnFailedEventSchema>

export const TurnCancelledEventSchema = TurnEventPositionSchema.extend({
  event: z.literal('turn.cancelled'),
  turn: TurnSchema,
})
export type TurnCancelledEvent = z.infer<typeof TurnCancelledEventSchema>

export const ItemStartedEventSchema = TurnEventPositionSchema.extend({
  event: z.literal('item.started'),
  item: ItemSchema,
})
export type ItemStartedEvent = z.infer<typeof ItemStartedEventSchema>

export const ItemDeltaEventSchema = TurnEventPositionSchema.extend({
  event: z.literal('item.delta'),
  itemId: ItemIdSchema,
  /** Streaming text appended to the item's latest content. */
  delta: z.string(),
})
export type ItemDeltaEvent = z.infer<typeof ItemDeltaEventSchema>

export const ItemCompletedEventSchema = TurnEventPositionSchema.extend({
  event: z.literal('item.completed'),
  item: ItemSchema,
})
export type ItemCompletedEvent = z.infer<typeof ItemCompletedEventSchema>

export const ItemFailedEventSchema = TurnEventPositionSchema.extend({
  event: z.literal('item.failed'),
  itemId: ItemIdSchema,
  error: z.string().min(1),
})
export type ItemFailedEvent = z.infer<typeof ItemFailedEventSchema>

/**
 * A loop checkpoint (architecture §10.1 Record). Runtime-authored history
 * clients may ignore: it marks that every step effect before it is durable
 * and carries a digest of the rebuilt message history for crash recovery.
 */
export const AgentCheckpointEventSchema = TurnEventPositionSchema.extend({
  event: z.literal('agent.checkpoint'),
  stepIndex: z.number().int().nonnegative(),
  stateDigest: z.string().min(1),
})
export type AgentCheckpointEvent = z.infer<typeof AgentCheckpointEventSchema>

/** A checkpoint whose durable history no longer reproduces its digest. */
export const AgentRecoveryFailedEventSchema = TurnEventPositionSchema.extend({
  event: z.literal('agent.recovery_failed'),
  checkpointSequence: z.number().int().positive(),
  expectedDigest: z.string().min(1),
  actualDigest: z.string().min(1),
})
export type AgentRecoveryFailedEvent = z.infer<
  typeof AgentRecoveryFailedEventSchema
>

/**
 * A durable conversation summary (architecture §10.4, level-2 compaction):
 * the covered message prefix of the thread's history is replaced — in the
 * model-visible projection only — by the summary this event carries. The
 * covered digest makes the summary self-verifying against the history it
 * summarizes; the full history stays in Chronicle untouched.
 */
export const ContextCompactedEventSchema = TurnEventPositionSchema.extend({
  event: z.literal('context.compacted'),
  summary: z.string().min(1),
  /** How many leading history messages the summary covers. */
  coveredMessageCount: z.number().int().positive(),
  /** sha256 over the covered history prefix at compaction time. */
  coveredDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** Estimated tokens the covered span occupied. */
  coveredTokens: z.number().int().positive(),
  reason: z.literal('context-pressure'),
})
export type ContextCompactedEvent = z.infer<typeof ContextCompactedEventSchema>

export const ThreadEventSchema = z.discriminatedUnion('event', [
  ThreadCreatedEventSchema,
  TurnStartedEventSchema,
  TurnCompletedEventSchema,
  TurnFailedEventSchema,
  TurnCancelledEventSchema,
  ItemStartedEventSchema,
  ItemDeltaEventSchema,
  ItemCompletedEventSchema,
  ItemFailedEventSchema,
  AgentCheckpointEventSchema,
  AgentRecoveryFailedEventSchema,
  ContextCompactedEventSchema,
])
export type ThreadEvent = z.infer<typeof ThreadEventSchema>

/**
 * One page of recovered history. `hasMore` tells the client to fetch again
 * with `after` set to the last received sequence; events arrive in sequence
 * order and sequences are contiguous per thread, so nothing between two
 * pages can be missed.
 */
export const ThreadEventPageSchema = z.object({
  events: z.array(ThreadEventSchema),
  hasMore: z.boolean(),
})
export type ThreadEventPage = z.infer<typeof ThreadEventPageSchema>

/** Options for reading thread history; `after` 0 or omitted means the start. */
export interface ThreadEventQuery {
  readonly after?: number
  readonly limit?: number
}
