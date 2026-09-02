import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import { KanbanTaskNotFoundError, transitionAlongPath } from '@bee-agent/kanban'
import type {
  KanbanStore,
  KanbanTaskId,
  KanbanTaskStatus,
} from '@bee-agent/kanban'

const TaskIdParamsSchema = z.object({ taskId: z.uuid() })

const PrioritySchema = z.enum(['lowest', 'low', 'medium', 'high', 'urgent'])
const StatusSchema = z.enum([
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
])

const CreateTaskBodySchema = z.object({
  title: z.string().min(1),
  priority: PrioritySchema.optional(),
  goal: z.string().min(1).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).optional(),
  labels: z.array(z.string().min(1)).optional(),
  deadline: z.iso.datetime().optional(),
  scheduledAt: z.iso.datetime().optional(),
  idempotencyKey: z.string().min(1).optional(),
  source: z
    .object({ threadId: z.uuid(), turnId: z.uuid().optional() })
    .optional(),
})

const ListQuerySchema = z.object({
  status: StatusSchema.optional(),
  priority: PrioritySchema.optional(),
  labels: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
})

const UpdateTaskBodySchema = z.object({
  title: z.string().min(1).optional(),
  goal: z.string().min(1).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).optional(),
  priority: PrioritySchema.optional(),
  labels: z.array(z.string().min(1)).optional(),
  deadline: z.iso.datetime().optional(),
  scheduledAt: z.iso.datetime().optional(),
})

const ReasonBodySchema = z.object({ reason: z.string().min(1).optional() })
const CommentBodySchema = z.object({
  body: z.string().min(1),
  author: z.string().min(1).optional(),
})

async function requireTask(
  store: KanbanStore,
  taskId: KanbanTaskId,
): Promise<NonNullable<Awaited<ReturnType<KanbanStore['get']>>>> {
  const task = await store.get(taskId)
  if (task === undefined) throw new KanbanTaskNotFoundError(taskId)
  return task
}

async function transitionTo(
  store: KanbanStore,
  taskId: KanbanTaskId,
  to: KanbanTaskStatus,
  reason?: string | undefined,
) {
  // Same semantics as the agent tool: one call walks the shortest legal
  // chain, every hop a durable event; illegal targets name their legal ones.
  return transitionAlongPath(store, taskId, to, reason)
}

/**
 * The Kanban REST API (architecture §15.3, v1 refactor plan §5.2 P2-3): the
 * same store the agent tools, CLI, Web, and Scheduler share. Tasks are the
 * durable card; status changes append Chronicle events under expected-version.
 */
export const kanbanRoutes: FastifyPluginAsync = async (app) => {
  const { kanban } = app.bee

  app.post('/kanban/tasks', async (request, reply) => {
    const body = CreateTaskBodySchema.parse(request.body)
    const task = await kanban.create(body)
    return reply.code(201).send(task)
  })

  app.get('/kanban/tasks', async (request) => {
    const query = ListQuerySchema.parse(request.query ?? {})
    return kanban.list({
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.priority !== undefined ? { priority: query.priority } : {}),
      ...(query.labels !== undefined
        ? { labels: query.labels.split(',').filter((label) => label !== '') }
        : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    })
  })

  app.get('/kanban/tasks/:taskId', async (request) => {
    const { taskId } = TaskIdParamsSchema.parse(request.params)
    return requireTask(kanban, taskId as KanbanTaskId)
  })

  app.patch('/kanban/tasks/:taskId', async (request) => {
    const { taskId } = TaskIdParamsSchema.parse(request.params)
    const body = UpdateTaskBodySchema.parse(request.body)
    const task = await requireTask(kanban, taskId as KanbanTaskId)
    return kanban.update(taskId as KanbanTaskId, {
      expectedVersion: task.version,
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.goal !== undefined ? { goal: body.goal } : {}),
      ...(body.acceptanceCriteria !== undefined
        ? { acceptanceCriteria: body.acceptanceCriteria }
        : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.labels !== undefined ? { labels: body.labels } : {}),
      ...(body.deadline !== undefined ? { deadline: body.deadline } : {}),
      ...(body.scheduledAt !== undefined
        ? { scheduledAt: body.scheduledAt }
        : {}),
    })
  })

  app.post('/kanban/tasks/:taskId/block', async (request) => {
    const { taskId } = TaskIdParamsSchema.parse(request.params)
    const body = ReasonBodySchema.parse(request.body ?? {})
    return transitionTo(kanban, taskId as KanbanTaskId, 'blocked', body.reason)
  })

  app.post('/kanban/tasks/:taskId/comment', async (request) => {
    const { taskId } = TaskIdParamsSchema.parse(request.params)
    const body = CommentBodySchema.parse(request.body)
    return kanban.comment(taskId as KanbanTaskId, {
      body: body.body,
      author: body.author ?? 'user',
    })
  })

  app.post('/kanban/tasks/:taskId/complete', async (request) => {
    const { taskId } = TaskIdParamsSchema.parse(request.params)
    return transitionTo(kanban, taskId as KanbanTaskId, 'done')
  })

  app.post('/kanban/tasks/:taskId/cancel', async (request) => {
    const { taskId } = TaskIdParamsSchema.parse(request.params)
    return transitionTo(kanban, taskId as KanbanTaskId, 'cancelled')
  })

  // Explicit status transition (drag-and-drop, CLI): one legal hop —
  // the error names the legal targets when the request is illegal.
  app.post('/kanban/tasks/:taskId/transition', async (request) => {
    const { taskId } = TaskIdParamsSchema.parse(request.params)
    const body = z
      .object({
        to: z.enum([
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
        ]),
        reason: z.string().min(1).optional(),
      })
      .parse(request.body)
    return transitionTo(kanban, taskId as KanbanTaskId, body.to, body.reason)
  })
}
