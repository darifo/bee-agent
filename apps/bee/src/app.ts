import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import type { ChronicleStore } from '@bee-agent/knowledge'
import { AgentLoop } from '@bee-agent/runtime'
import type { AgentLoopToolSlot, LlmRuntime } from '@bee-agent/runtime'
import { BroadcastingChronicleStore } from './broadcasting-store.js'
import { sendErrorResponse } from './errors.js'
import { threadRoutes } from './routes/threads.js'

export interface BeeServerOptions {
  /** The Chronicle store holding thread streams (migrated, registry wired). */
  readonly store: ChronicleStore
  readonly llm: LlmRuntime
  /** Tool execution seam; wired directly until ExecutionWorld lands (P1-17+). */
  readonly tools: AgentLoopToolSlot
  readonly logger?: boolean | undefined
  /** CORS origin policy; P1-14 tightens the default to self-origin. */
  readonly corsOrigin?: boolean | string[] | undefined
}

export interface BeeServer {
  readonly app: FastifyInstance
  readonly store: BroadcastingChronicleStore
  readonly loop: AgentLoop
}

/**
 * The Personal Bee Host (architecture §9.1) minimal form: one Fastify
 * process serving the Thread–Turn–Item API over a Chronicle store. The
 * Cordis kernel and Kanban plane join in later phases; here the loop, store,
 * and HTTP surface are wired directly.
 */
export async function buildBeeServer(
  options: BeeServerOptions,
): Promise<BeeServer> {
  const store = new BroadcastingChronicleStore(options.store)
  const loop = new AgentLoop({
    llm: options.llm,
    store,
    tools: options.tools,
  })

  const app = Fastify({ logger: options.logger ?? true })
  app.decorate('bee', { store, loop })
  await app.register(cors, {
    origin: options.corsOrigin ?? true,
    methods: ['GET', 'POST'],
  })
  app.setErrorHandler(async (error, request, reply) => {
    await sendErrorResponse(error, request, reply)
  })
  app.get('/health', async () => ({ status: 'ok' }))
  await app.register(threadRoutes, {
    corsOrigin: options.corsOrigin ?? true,
  })
  app.addHook('onClose', async () => {
    await store.close()
  })
  return { app, store, loop }
}
