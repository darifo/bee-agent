import type {
  KanbanPriority,
  KanbanTask,
  KanbanTaskId,
  KanbanTaskStatus,
} from './protocol.ts'
import type { KanbanStore } from './store.ts'
import { KanbanTaskNotFoundError } from './store.ts'

/**
 * The Kanban agent tools (architecture §15.3): the eight `kanban_*` tools in
 * a lazy-loadable registry form. Each definition carries only its id,
 * description, and input JSON Schema, so the Tool Index (P2-8) can expose
 * the names cheaply and resolve a definition only when the model calls it.
 */

export interface KanbanToolDefinition {
  readonly id: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

const stringField = { type: 'string' } as const
const PRIORITY_ENUM = {
  type: 'string',
  enum: ['lowest', 'low', 'medium', 'high', 'urgent'],
} as const
const STATUS_ENUM = {
  type: 'string',
  enum: [
    'inbox',
    'triaged',
    'ready',
    'running',
    'blocked',
    'review',
    'done',
    'failed',
    'cancelled',
    'archived',
  ],
} as const

function withId(
  required: readonly string[],
  properties: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'object',
    required: ['id', ...required],
    properties: {
      id: { type: 'string', description: 'Task id' },
      ...properties,
    },
  }
}

const TASK_FIELDS = {
  title: { type: 'string', description: 'Task title' },
  goal: { type: 'string' },
  acceptanceCriteria: { type: 'array', items: stringField },
  priority: PRIORITY_ENUM,
  labels: { type: 'array', items: stringField },
  deadline: { type: 'string', description: 'ISO 8601 datetime' },
  scheduledAt: { type: 'string', description: 'ISO 8601 datetime' },
}

export const KANBAN_TOOL_DEFINITIONS: readonly KanbanToolDefinition[] = [
  {
    id: 'kanban_create',
    description: 'Create a new kanban task in the inbox',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: TASK_FIELDS,
    },
  },
  {
    id: 'kanban_list',
    description: 'List kanban tasks, optionally filtered',
    inputSchema: {
      type: 'object',
      properties: {
        status: STATUS_ENUM,
        labels: { type: 'array', items: stringField },
        priority: PRIORITY_ENUM,
        limit: { type: 'integer' },
      },
    },
  },
  {
    id: 'kanban_show',
    description: 'Show one kanban task by id',
    inputSchema: withId([], {}),
  },
  {
    id: 'kanban_update',
    description: 'Update a task title, goal, priority, labels, or schedule',
    inputSchema: withId([], TASK_FIELDS),
  },
  {
    id: 'kanban_block',
    description: 'Mark a running task as blocked, with an optional reason',
    inputSchema: withId([], { reason: { type: 'string' } }),
  },
  {
    id: 'kanban_comment',
    description: 'Append a comment to a task',
    inputSchema: withId(['body'], {
      body: { type: 'string' },
      author: { type: 'string' },
    }),
  },
  {
    id: 'kanban_complete',
    description: 'Mark a task as done',
    inputSchema: withId([], {}),
  },
  {
    id: 'kanban_cancel',
    description: 'Cancel a task',
    inputSchema: withId([], {}),
  },
]

export interface KanbanToolResult {
  readonly output: unknown
  readonly content: string
}

export interface KanbanToolInput {
  readonly toolId: string
  readonly input: unknown
}

export interface KanbanToolExecutor {
  execute(input: KanbanToolInput): Promise<KanbanToolResult>
}

type Args = Record<string, unknown>

function requireString(args: Args, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`'${key}' must be a non-empty string`)
  }
  return value
}

function optionalString(args: Args, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalStringArray(args: Args, key: string): string[] | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string')
  ) {
    throw new Error(`'${key}' must be an array of strings`)
  }
  return value as string[]
}

const PRIORITIES: readonly KanbanPriority[] = [
  'lowest',
  'low',
  'medium',
  'high',
  'urgent',
]
const STATUSES: readonly KanbanTaskStatus[] = [
  'inbox',
  'triaged',
  'ready',
  'running',
  'blocked',
  'review',
  'done',
  'failed',
  'cancelled',
  'archived',
]

function optionalEnum<T extends string>(
  args: Args,
  key: string,
  values: readonly T[],
): T | undefined {
  const value = optionalString(args, key)
  if (value === undefined) return undefined
  if (!values.includes(value as T)) {
    throw new Error(`'${key}' must be one of ${values.join('/')}`)
  }
  return value as T
}

function resultOf(value: unknown): KanbanToolResult {
  return { output: value, content: JSON.stringify(value) }
}

async function requireTask(
  store: KanbanStore,
  id: KanbanTaskId,
): Promise<KanbanTask> {
  const task = await store.get(id)
  if (task === undefined) throw new KanbanTaskNotFoundError(id)
  return task
}

async function transitionTo(
  store: KanbanStore,
  id: KanbanTaskId,
  to: KanbanTaskStatus,
  reason?: string | undefined,
): Promise<KanbanTask> {
  const task = await requireTask(store, id)
  return store.transition(id, { to, expectedVersion: task.version, reason })
}

/**
 * The kanban tool executor: routes a `{ toolId, input }` from the model to
 * the shared store. Returns `{ output, content }` so the caller can adapt it
 * to any tool-slot shape; errors propagate for the host to surface as a tool
 * result.
 */
export function createKanbanToolExecutor(
  store: KanbanStore,
): KanbanToolExecutor {
  return {
    async execute({ toolId, input }) {
      const args = (input ?? {}) as Args
      switch (toolId) {
        case 'kanban_create': {
          const title = requireString(args, 'title')
          const goal = optionalString(args, 'goal')
          const acceptanceCriteria = optionalStringArray(
            args,
            'acceptanceCriteria',
          )
          const priority = optionalEnum(args, 'priority', PRIORITIES)
          const labels = optionalStringArray(args, 'labels')
          const deadline = optionalString(args, 'deadline')
          const scheduledAt = optionalString(args, 'scheduledAt')
          return resultOf(
            await store.create({
              title,
              ...(goal !== undefined ? { goal } : {}),
              ...(acceptanceCriteria !== undefined
                ? { acceptanceCriteria }
                : {}),
              ...(priority !== undefined ? { priority } : {}),
              ...(labels !== undefined ? { labels } : {}),
              ...(deadline !== undefined ? { deadline } : {}),
              ...(scheduledAt !== undefined ? { scheduledAt } : {}),
            }),
          )
        }
        case 'kanban_list': {
          const status = optionalEnum(args, 'status', STATUSES)
          const labels = optionalStringArray(args, 'labels')
          const priority = optionalEnum(args, 'priority', PRIORITIES)
          const limit = typeof args.limit === 'number' ? args.limit : undefined
          return resultOf(
            await store.list({
              ...(status !== undefined ? { status } : {}),
              ...(labels !== undefined ? { labels } : {}),
              ...(priority !== undefined ? { priority } : {}),
              ...(limit !== undefined ? { limit } : {}),
            }),
          )
        }
        case 'kanban_show': {
          const id = requireString(args, 'id') as KanbanTaskId
          return resultOf(await requireTask(store, id))
        }
        case 'kanban_update': {
          const id = requireString(args, 'id') as KanbanTaskId
          const current = await requireTask(store, id)
          const title = optionalString(args, 'title')
          const goal = optionalString(args, 'goal')
          const acceptanceCriteria = optionalStringArray(
            args,
            'acceptanceCriteria',
          )
          const priority = optionalEnum(args, 'priority', PRIORITIES)
          const labels = optionalStringArray(args, 'labels')
          const deadline = optionalString(args, 'deadline')
          const scheduledAt = optionalString(args, 'scheduledAt')
          return resultOf(
            await store.update(id, {
              expectedVersion: current.version,
              ...(title !== undefined ? { title } : {}),
              ...(goal !== undefined ? { goal } : {}),
              ...(acceptanceCriteria !== undefined
                ? { acceptanceCriteria }
                : {}),
              ...(priority !== undefined ? { priority } : {}),
              ...(labels !== undefined ? { labels } : {}),
              ...(deadline !== undefined ? { deadline } : {}),
              ...(scheduledAt !== undefined ? { scheduledAt } : {}),
            }),
          )
        }
        case 'kanban_block': {
          const id = requireString(args, 'id') as KanbanTaskId
          return resultOf(
            await transitionTo(
              store,
              id,
              'blocked',
              optionalString(args, 'reason'),
            ),
          )
        }
        case 'kanban_comment': {
          const id = requireString(args, 'id') as KanbanTaskId
          return resultOf(
            await store.comment(id, {
              body: requireString(args, 'body'),
              author: optionalString(args, 'author') ?? 'agent',
            }),
          )
        }
        case 'kanban_complete': {
          const id = requireString(args, 'id') as KanbanTaskId
          return resultOf(await transitionTo(store, id, 'done'))
        }
        case 'kanban_cancel': {
          const id = requireString(args, 'id') as KanbanTaskId
          return resultOf(await transitionTo(store, id, 'cancelled'))
        }
        default:
          throw new Error(`Unknown kanban tool '${toolId}'`)
      }
    },
  }
}
