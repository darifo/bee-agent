import Fastify from 'fastify'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import type { ChronicleStore } from '@bee-agent/knowledge'
import {
  KANBAN_TOOL_DEFINITIONS,
  createKanbanToolExecutor,
} from '@bee-agent/kanban'
import type { KanbanStore } from '@bee-agent/kanban'
import { AgentLoop } from '@bee-agent/runtime'
import type {
  AgentLoopToolSlot,
  LlmRuntime,
  LlmToolSpec,
} from '@bee-agent/runtime'
import { BroadcastingChronicleStore } from './broadcasting-store.ts'
import { sendErrorResponse } from './errors.ts'
import { kanbanRoutes } from './routes/kanban.ts'
import { threadRoutes } from './routes/threads.ts'

/**
 * CORS origin policy. `false` denies all cross-origin requests; a string
 * array allows exactly those origins; a function decides per request.
 */
export type CorsOriginPolicy =
  boolean | string[] | ((origin: string | undefined) => boolean)

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
])

/**
 * The default origin policy (architecture §16.4): only loopback origins are
 * allowed. `@fastify/cors` `true` would reflect any origin; this fails
 * closed instead, so a browser page on a remote host cannot drive the API.
 */
export function loopbackOrigins(origin: string | undefined): boolean {
  if (origin === undefined) return false
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname)
  } catch {
    return false
  }
}

/** True when a listening address is loopback-only (the safe default). */
export function isLoopbackHost(host: string): boolean {
  return (
    host === '127.0.0.1' ||
    host === 'localhost' ||
    host === '::1' ||
    host === '::'
  )
}

/**
 * Fail-closed listen guard (architecture §16.4): binding a non-loopback
 * address without a session token is refused, so neither a stray
 * `BEE_AGENT_HOST` nor a plugin can silently expose the host. Returns the
 * refusal reason, or `undefined` when the listen is safe.
 */
export function unsafeListenReason(
  host: string,
  sessionToken: string | undefined,
): string | undefined {
  if (!isLoopbackHost(host) && (sessionToken ?? '') === '') {
    return 'Refusing to bind a non-loopback host without BEE_AGENT_SESSION_TOKEN'
  }
  return undefined
}

export interface BeeServerOptions {
  /** The Chronicle store holding thread streams (migrated, registry wired). */
  readonly store: ChronicleStore
  /** The kanban store shared by the REST API, agent tools, and dispatcher. */
  readonly kanban: KanbanStore
  readonly llm: LlmRuntime
  /** Tool execution seam for non-kanban tools; wired directly until ExecutionWorld lands. */
  readonly tools: AgentLoopToolSlot
  /** Extra tool specs appended after the built-in kanban tools. */
  readonly toolSpecs?: readonly LlmToolSpec[] | undefined
  readonly logger?: boolean | undefined
  /** CORS origin policy; defaults to loopback-only (never reflects any). */
  readonly corsOrigin?: CorsOriginPolicy | undefined
  /**
   * When set, every request except `/health` must present
   * `Authorization: Bearer <sessionToken>`. The host generates one per
   * startup for the local Web client (architecture §16.4 one-time token).
   */
  readonly sessionToken?: string | undefined
}

export interface BeeServer {
  readonly app: FastifyInstance
  readonly store: BroadcastingChronicleStore
  readonly kanban: KanbanStore
  readonly loop: AgentLoop
}

function toFastifyCorsOrigin(
  policy: CorsOriginPolicy,
):
  | boolean
  | string[]
  | ((
      origin: string | undefined,
      callback: (error: Error | null, allow: boolean) => void,
    ) => void) {
  if (typeof policy === 'function') {
    return (origin, callback) => callback(null, policy(origin))
  }
  return policy
}

/**
 * Wraps the caller's tool slot with the built-in kanban tools. `kanban_*`
 * calls route to the kanban executor over the shared store; everything else
 * delegates to the caller's slot. Kanban tool failures surface as error tool
 * results so the model can respond instead of crashing the turn.
 */
function compositeToolSlot(
  kanban: KanbanStore,
  fallback: AgentLoopToolSlot,
): AgentLoopToolSlot {
  const executor = createKanbanToolExecutor(kanban)
  return {
    async execute(call) {
      if (!call.call.toolId.startsWith('kanban_')) {
        return fallback.execute(call)
      }
      try {
        const result = await executor.execute({
          toolId: call.call.toolId,
          input: call.call.input,
        })
        return {
          kind: 'result',
          output: result.output,
          content: result.content,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          kind: 'result',
          output: { error: message },
          content: message,
          isError: true,
        }
      }
    },
  }
}

/**
 * The Personal Bee Host (architecture §9.1) minimal form: one Fastify
 * process serving the Thread–Turn–Item API over a Chronicle store. Security
 * defaults (architecture §16.4) apply out of the box: loopback-only CORS and
 * an optional one-time session token; remote exposure is a caller decision.
 */
export async function buildBeeServer(
  options: BeeServerOptions,
): Promise<BeeServer> {
  const store = new BroadcastingChronicleStore(options.store)
  const loop = new AgentLoop({
    llm: options.llm,
    store,
    tools: compositeToolSlot(options.kanban, options.tools),
    toolSpecs: [
      ...KANBAN_TOOL_DEFINITIONS.map((definition) => ({
        id: definition.id,
        description: definition.description,
        inputSchema: definition.inputSchema,
      })),
      ...(options.toolSpecs ?? []),
    ],
  })

  const corsOrigin = options.corsOrigin ?? loopbackOrigins

  const app = Fastify({ logger: options.logger ?? true })
  app.decorate('bee', { store, kanban: options.kanban, loop })

  if (options.sessionToken !== undefined) {
    app.addHook('onRequest', async (request, reply) => {
      if (request.url === '/health') return
      const authorization = request.headers.authorization
      const provided = authorization?.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : undefined
      if (provided !== options.sessionToken) {
        await denyUnauthorized(request, reply)
      }
    })
  }

  await app.register(cors, {
    origin: toFastifyCorsOrigin(corsOrigin),
    methods: ['GET', 'POST'],
  })
  app.setErrorHandler(async (error, request, reply) => {
    await sendErrorResponse(error, request, reply)
  })
  app.get('/health', async () => ({ status: 'ok' }))
  await app.register(threadRoutes, { corsOrigin })
  await app.register(kanbanRoutes)
  app.addHook('onClose', async () => {
    await store.close()
  })
  return { app, store, kanban: options.kanban, loop }
}

async function denyUnauthorized(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (reply.sent) return
  await reply
    .code(401)
    .send({ code: 'unauthorized', message: 'Missing or invalid session token' })
}
