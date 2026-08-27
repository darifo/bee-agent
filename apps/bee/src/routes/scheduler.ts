import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { AgentScheduler } from '@bee-agent/runtime'
import { SchedulerTriggerNotFoundError } from '@bee-agent/runtime'

/**
 * Scheduler routes (v1 refactor plan §5.5 WF4-F): register one-shot or
 * recurring triggers that continue a bound thread across days and restarts,
 * inspect the durable schedule, run a manual tick, and remove triggers.
 * Every mutation is a Chronicle fact on the `scheduler` stream.
 */

const WhenBodySchema = z
  .object({
    taskStatus: z
      .object({
        taskId: z.uuid(),
        status: z.enum([
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
      })
      .optional(),
    event: z
      .object({
        streamPrefix: z.string().min(1).optional(),
        eventType: z.string().min(1),
      })
      .optional(),
  })
  .strict()
  .refine(
    (when) => (when.taskStatus !== undefined) !== (when.event !== undefined),
    {
      message: 'Exactly one of taskStatus or event is required',
    },
  )

const CreateTriggerBodySchema = z.object({
  input: z.string().min(1),
  threadId: z.uuid(),
  at: z.iso.datetime().optional(),
  intervalMs: z.number().int().positive().optional(),
  when: WhenBodySchema.optional(),
})

const TriggerIdParamsSchema = z.object({ triggerId: z.uuid() })
const ReasonBodySchema = z.object({ reason: z.string().min(1).optional() })

export const schedulerRoutes: FastifyPluginAsync<{
  scheduler: AgentScheduler
}> = async (app, options) => {
  const { scheduler } = options

  app.get('/scheduler/triggers', async () => {
    return { triggers: scheduler.list() }
  })

  app.post('/scheduler/triggers', async (request, reply) => {
    const body = CreateTriggerBodySchema.parse(request.body)
    const trigger = await scheduler.register(body)
    return reply.code(201).send({ trigger })
  })

  app.post('/scheduler/tick', async () => {
    return scheduler.tick()
  })

  app.delete('/scheduler/triggers/:triggerId', async (request, reply) => {
    const { triggerId } = TriggerIdParamsSchema.parse(request.params)
    const body = ReasonBodySchema.parse(request.body ?? {})
    try {
      await scheduler.remove(
        triggerId,
        body.reason === undefined ? undefined : body.reason,
      )
    } catch (error) {
      if (error instanceof SchedulerTriggerNotFoundError) {
        return reply.code(404).send({
          code: 'not-found',
          message: error.message,
        })
      }
      throw error
    }
    return reply.code(200).send({ removed: true })
  })
}
