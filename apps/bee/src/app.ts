import Fastify from 'fastify'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import type { ChronicleStore } from '@bee-agent/knowledge'
import { AgentLoop } from '@bee-agent/runtime'
import type { AgentLoopToolSlot, LlmRuntime } from '@bee-agent/runtime'
import { BroadcastingChronicleStore } from './broadcasting-store.js'
import { sendErrorResponse } from './errors.js'
import { threadRoutes } from './routes/threads.js'

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
  readonly llm: LlmRuntime
  /** Tool execution seam; wired directly until ExecutionWorld lands (P1-17+). */
  readonly tools: AgentLoopToolSlot
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
    tools: options.tools,
  })

  const corsOrigin = options.corsOrigin ?? loopbackOrigins

  const app = Fastify({ logger: options.logger ?? true })
  app.decorate('bee', { store, loop })

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
  app.addHook('onClose', async () => {
    await store.close()
  })
  return { app, store, loop }
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
