import { z } from 'zod'
import type { AgentEvent } from '@bee-agent/contracts'
import { taskEventRecordedEvent } from '@bee-agent/runtime'
import type { FastifyPluginAsync } from 'fastify'
import { requireSnapshot } from './tasks.js'

const TaskIdParamsSchema = z.object({ taskId: z.uuid() })

const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'task.completed',
  'task.failed',
  'task.cancelled',
])

const HEARTBEAT_MS = 15_000

/**
 * Streams a task's events over Server-Sent Events. Recorded events after the
 * `Last-Event-ID` header (or `?after=`) are replayed first, then live events
 * follow; the stream closes once the task reaches a terminal state or the
 * client disconnects.
 */
export const streamRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/tasks/:taskId/events/stream',
    { logLevel: 'warn' },
    async (request, reply) => {
      const { taskId } = TaskIdParamsSchema.parse(request.params)
      const { runtime, kernel } = app.bee
      await requireSnapshot(runtime, taskId)
      const header = request.headers['last-event-id']
      const queryAfter = Number(
        (request.query as { after?: string } | undefined)?.after ?? '0',
      )
      const after = header
        ? Math.max(0, Number(header) || 0)
        : Number.isFinite(queryAfter)
          ? Math.max(0, queryAfter)
          : 0

      reply.hijack()
      const raw = reply.raw
      raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })

      let watermark = after
      let closed = false
      const queue: AgentEvent[] = []
      let wake: (() => void) | undefined

      const send = (event: AgentEvent): boolean => {
        if (event.sequence <= watermark) return false
        watermark = event.sequence
        raw.write(
          `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        return TERMINAL_EVENT_TYPES.has(event.type)
      }

      const off = kernel.events.on(taskEventRecordedEvent, ({ event }) => {
        if (event.taskId !== taskId) return
        if (event.sequence > watermark) {
          queue.push(event)
          wake?.()
        }
      })

      const heartbeat = setInterval(() => {
        if (!closed) raw.write(': heartbeat\n\n')
      }, HEARTBEAT_MS)

      const finish = () => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        off()
        raw.end()
        wake?.()
      }

      raw.on('close', finish)
      try {
        for await (const event of runtime.readEvents(taskId, watermark)) {
          if (closed) break
          if (send(event)) {
            finish()
            break
          }
        }
        while (!closed) {
          while (queue.length > 0 && !closed) {
            const event = queue.shift()!
            if (send(event)) {
              finish()
              break
            }
          }
          if (closed) break
          await new Promise<void>((resolve) => {
            wake = resolve
          })
          wake = undefined
        }
      } catch (error) {
        request.log.error(error, `event stream for task '${taskId}' failed`)
        finish()
      } finally {
        finish()
      }
    },
  )
}
