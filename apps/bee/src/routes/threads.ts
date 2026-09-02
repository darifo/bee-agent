import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { ChronicleEvent } from '@bee-agent/knowledge'
import type { CorsOriginPolicy } from '../app.ts'
import { loopbackOrigins } from '../app.ts'
import {
  appendThreadEvents,
  listThreadSummaries,
  newThread,
  readThreadEvents,
  threadCreatedEvent,
  threadEventFromChronicle,
  threadStreamId,
} from '@bee-agent/thread'
import type { ThreadEvent, ThreadId, TurnId } from '@bee-agent/thread'

const ThreadIdParamsSchema = z.object({ threadId: z.uuid() })
const ApprovalParamsSchema = z.object({
  threadId: z.uuid(),
  turnId: z.uuid(),
  approvalId: z.string().min(1),
})

const CreateThreadBodySchema = z.object({
  title: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  memoryView: z
    .object({ id: z.string().min(1), version: z.string().min(1) })
    .optional(),
})

const CreateTurnBodySchema = z.object({
  input: z.string().min(1),
  structureVersion: z.string().min(1).optional(),
})

const DecideApprovalBodySchema = z.object({
  decision: z.enum(['approved', 'rejected']),
})

const HEARTBEAT_MS = 15_000

export interface ThreadRoutesOptions {
  readonly corsOrigin?: CorsOriginPolicy | undefined
  /** Registry the routes use to make in-flight turns abortable. */
  readonly turnCancels?: TurnCancellationRegistry | undefined
}

/**
 * Tracks the abort controllers of turns currently running per thread, so
 * `POST /threads/:threadId/cancel` can stop them; the original request
 * still settles normally with a `cancelled` result.
 */
export class TurnCancellationRegistry {
  readonly #byThread = new Map<string, Set<AbortController>>()

  add(threadId: string, controller: AbortController): void {
    const set = this.#byThread.get(threadId) ?? new Set<AbortController>()
    set.add(controller)
    this.#byThread.set(threadId, set)
  }

  remove(threadId: string, controller: AbortController): void {
    this.#byThread.get(threadId)?.delete(controller)
  }

  abortAll(threadId: string): number {
    const set = this.#byThread.get(threadId)
    if (set === undefined) return 0
    const count = set.size
    for (const controller of set) controller.abort()
    return count
  }
}

function allowOrigin(
  requestOrigin: string | undefined,
  corsOrigin: CorsOriginPolicy,
): string | undefined {
  if (corsOrigin === true) return requestOrigin ?? '*'
  if (corsOrigin === false) return undefined
  if (typeof corsOrigin === 'function') {
    return corsOrigin(requestOrigin) ? requestOrigin : undefined
  }
  if (requestOrigin !== undefined && corsOrigin.includes(requestOrigin)) {
    return requestOrigin
  }
  return undefined
}

export const threadRoutes: FastifyPluginAsync<ThreadRoutesOptions> = async (
  app,
  options,
) => {
  const { store, loop } = app.bee
  const turnCancels = options.turnCancels ?? new TurnCancellationRegistry()

  app.post('/threads', async (request, reply) => {
    const body = CreateThreadBodySchema.parse(request.body)
    const thread = newThread({
      title: body.title ?? 'New thread',
      workspaceId: body.workspaceId,
      memoryView: body.memoryView,
    })
    await appendThreadEvents(store, thread.id, [threadCreatedEvent(thread)])
    return reply.code(201).send(thread)
  })

  // The conversation list: a projection over the durable thread streams,
  // newest activity first. Read-only like every projection.
  app.get('/threads', async () => {
    return { threads: await listThreadSummaries(store) }
  })

  app.post('/threads/:threadId/turns', async (request, reply) => {
    const { threadId } = ThreadIdParamsSchema.parse(request.params)
    const body = CreateTurnBodySchema.parse(request.body)
    const controller = new AbortController()
    turnCancels.add(threadId, controller)
    try {
      const result = await loop.runTurn({
        threadId: threadId as ThreadId,
        input: body.input,
        structureVersion: body.structureVersion,
        signal: controller.signal,
      })
      return reply.send(result)
    } finally {
      turnCancels.remove(threadId, controller)
    }
  })

  // Stops the thread's in-flight turns; the awaiting POST /turns call
  // settles with a `cancelled` result and the transcript records the
  // turn.cancelled fact.
  app.post('/threads/:threadId/cancel', async (request) => {
    const { threadId } = ThreadIdParamsSchema.parse(request.params)
    return { cancelled: turnCancels.abortAll(threadId) }
  })

  app.post(
    '/threads/:threadId/turns/:turnId/approvals/:approvalId',
    async (request, reply) => {
      const { threadId, turnId, approvalId } = ApprovalParamsSchema.parse(
        request.params,
      )
      const body = DecideApprovalBodySchema.parse(request.body)
      const controller = new AbortController()
      turnCancels.add(threadId, controller)
      try {
        const result = await loop.resumeTurn({
          threadId: threadId as ThreadId,
          turnId: turnId as TurnId,
          approvalId,
          decision: body.decision,
          signal: controller.signal,
        })
        return reply.send(result)
      } finally {
        turnCancels.remove(threadId, controller)
      }
    },
  )

  app.get(
    '/threads/:threadId/items',
    { logLevel: 'warn' },
    async (request, reply) => {
      const { threadId } = ThreadIdParamsSchema.parse(request.params)
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
      const origin = allowOrigin(
        request.headers.origin,
        options.corsOrigin ?? loopbackOrigins,
      )
      raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        ...(origin !== undefined
          ? { 'access-control-allow-origin': origin }
          : {}),
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })

      let watermark = after
      let closed = false
      const queue: ThreadEvent[] = []
      let wake: (() => void) | undefined

      const send = (event: ThreadEvent): void => {
        if (event.sequence <= watermark) return
        watermark = event.sequence
        raw.write(
          `id: ${event.sequence}\nevent: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`,
        )
      }

      const onAppend = ({
        streamId,
        events,
      }: {
        streamId: string
        events: readonly ChronicleEvent[]
      }): void => {
        if (streamId !== threadStreamId(threadId)) return
        for (const stored of events) {
          const wire = threadEventFromChronicle(stored)
          if (wire.sequence > watermark) {
            queue.push(wire)
            wake?.()
          }
        }
      }

      const heartbeat = setInterval(() => {
        if (!closed) raw.write(': heartbeat\n\n')
      }, HEARTBEAT_MS)

      const finish = (): void => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        store.appended.off('append', onAppend)
        raw.end()
        wake?.()
      }

      store.appended.on('append', onAppend)
      raw.on('close', finish)

      try {
        // Replay everything after the client's last seen sequence, then
        // follow live appends. The subscription is registered first so an
        // append that lands between replay and drain is queued, not lost.
        const page = await readThreadEvents(store, threadId, {
          after: watermark,
        })
        for (const event of page.events) {
          if (closed) break
          send(event)
        }
        while (!closed) {
          while (queue.length > 0 && !closed) {
            const event = queue.shift()
            if (event !== undefined) send(event)
          }
          if (closed) break
          await new Promise<void>((resolve) => {
            wake = resolve
          })
          wake = undefined
        }
      } catch (error) {
        request.log.error(error, `item stream for thread '${threadId}' failed`)
        finish()
      } finally {
        finish()
      }
    },
  )
}
