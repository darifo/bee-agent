import { z } from 'zod'
import { CreateTaskRequestSchema } from '@bee-agent/contracts'
import type { AgentEvent } from '@bee-agent/contracts'
import type { Kernel } from '@bee-agent/kernel'
import { UnknownTaskError, taskEventRecordedEvent } from '@bee-agent/runtime'
import type { TaskRuntime, TaskSnapshot } from '@bee-agent/runtime'
import type { FastifyPluginAsync } from 'fastify'

const TaskIdParamsSchema = z.object({ taskId: z.uuid() })

const CancelBodySchema = z.object({ reason: z.string().min(1).optional() })

const EventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
})

/** Throws UnknownTaskError for ids with no recorded events. */
export async function requireSnapshot(
  runtime: TaskRuntime,
  taskId: string,
): Promise<TaskSnapshot> {
  const snapshot = await runtime.getSnapshot(taskId)
  if (snapshot.lastSequence === 0) throw new UnknownTaskError(taskId)
  return snapshot
}

/**
 * Resolves once the run appended its first lifecycle event, rejects when the
 * run fails before that (for example an invalid state), and resolves on the
 * timeout as a fallback.
 */
function trackRunStart(
  kernel: Kernel,
  taskId: string,
  timeoutMs = 5000,
): {
  readonly started: Promise<void>
  fail(error: unknown): void
} {
  let settle: (() => void) | undefined
  let rejectWith: ((error: unknown) => void) | undefined
  const started = new Promise<void>((resolve, reject) => {
    settle = resolve
    rejectWith = reject
  })
  let done = false
  const finish = (complete: () => void): void => {
    if (done) return
    done = true
    clearTimeout(timer)
    off()
    complete()
  }
  const off = kernel.events.on(taskEventRecordedEvent, ({ event }) => {
    if (event.taskId !== taskId || event.type === 'task.created') return
    finish(() => settle!())
  })
  const timer = setTimeout(() => finish(() => settle!()), timeoutMs)
  return { started, fail: (error) => finish(() => rejectWith!(error)) }
}

export const taskRoutes: FastifyPluginAsync = async (app) => {
  app.post('/tasks', async (request, reply) => {
    const body = CreateTaskRequestSchema.parse(request.body)
    const spec = await app.bee.runtime.createTask(body)
    return await reply.code(201).send({ task: spec, state: 'pending' })
  })

  app.get('/tasks/:taskId', async (request) => {
    const { taskId } = TaskIdParamsSchema.parse(request.params)
    return await requireSnapshot(app.bee.runtime, taskId)
  })

  app.post('/tasks/:taskId/run', async (request, reply) => {
    const { taskId } = TaskIdParamsSchema.parse(request.params)
    const { runtime, kernel } = app.bee
    await requireSnapshot(runtime, taskId)
    const tracker = trackRunStart(kernel, taskId)
    runtime.run(taskId).catch((error: unknown) => {
      tracker.fail(error)
      app.log.error(error, `task '${taskId}' run failed`)
    })
    await tracker.started
    return await reply.code(202).send(await runtime.getSnapshot(taskId))
  })

  app.post('/tasks/:taskId/cancel', async (request) => {
    const { taskId } = TaskIdParamsSchema.parse(request.params)
    const body = CancelBodySchema.parse(request.body ?? {})
    return await app.bee.runtime.cancel(taskId, body?.reason)
  })

  app.get('/tasks/:taskId/events', async (request) => {
    const { taskId } = TaskIdParamsSchema.parse(request.params)
    const query = EventsQuerySchema.parse(request.query ?? {})
    await requireSnapshot(app.bee.runtime, taskId)
    const events: AgentEvent[] = []
    for await (const event of app.bee.runtime.readEvents(
      taskId,
      query.after ?? 0,
    )) {
      events.push(event)
    }
    return { events }
  })
}
