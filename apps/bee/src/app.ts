import Fastify from 'fastify'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import type { ChronicleStore } from '@bee-agent/knowledge'
import type {
  EffectiveStructure,
  Kernel,
  PluginCatalog,
  ReconcileResult,
} from '@bee-agent/kernel'
import {
  KANBAN_TOOL_DEFINITIONS,
  createKanbanToolExecutor,
} from '@bee-agent/kanban'
import type { KanbanStore } from '@bee-agent/kanban'
import type {
  ToolAuthorizationRule,
  ToolAdapter,
  ToolExecutor,
  LlmRuntime,
  LlmToolSpec,
  SandboxProvider,
  SecretBroker,
  StructureReconciler,
  StructureConfigController,
  ConfigSource,
} from '@bee-agent/runtime'
import { BroadcastingChronicleStore } from './broadcasting-store.ts'
import { sendErrorResponse } from './errors.ts'
import {
  createBeeKernelRuntime,
  type AgentLoopService,
} from './kernel-runtime.ts'
import { kanbanRoutes } from './routes/kanban.ts'
import { threadRoutes } from './routes/threads.ts'
import { structureRoutes } from './routes/structure.ts'

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
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
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
  /** Coherent non-Kanban tool bindings; specs and rules are derived from them. */
  readonly toolAdapters?: readonly ToolAdapter[] | undefined
  /** Custom fallback for dynamically supplied test or embedding tools. */
  readonly toolExecutor?: ToolExecutor | undefined
  readonly toolAuthorization?: readonly ToolAuthorizationRule[] | undefined
  readonly sandboxProvider?: SandboxProvider | undefined
  readonly secretBroker?: SecretBroker | undefined
  /** Extra tool specs appended after the built-in kanban tools. */
  readonly toolSpecs?: readonly LlmToolSpec[] | undefined
  readonly effectiveStructure?: EffectiveStructure | undefined
  readonly modelId?: string | undefined
  readonly modelProviders?: ReadonlyMap<string, LlmRuntime> | undefined
  readonly pluginCatalog?: PluginCatalog | undefined
  readonly configSource?: ConfigSource | undefined
  readonly restoreActiveStructure?: boolean | undefined
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
  readonly loop: AgentLoopService
  readonly kernel: Kernel
  readonly structures: StructureReconciler
  readonly configController: StructureConfigController | undefined
  reconcileStructure(structure: EffectiveStructure): Promise<ReconcileResult>
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
 * delegates to the caller's executor. Kanban tool failures surface as error tool
 * results so the model can respond instead of crashing the turn.
 */
function compositeToolExecutor(
  kanban: KanbanStore,
  adapters: readonly ToolAdapter[],
  fallback: ToolExecutor | undefined,
): ToolExecutor {
  const executor = createKanbanToolExecutor(kanban)
  const registered = new Map<string, ToolAdapter>()
  for (const adapter of adapters) {
    if (adapter.authorization.toolId !== adapter.spec.id) {
      throw new Error(
        `Tool adapter '${adapter.spec.id}' authorization targets '${adapter.authorization.toolId}'`,
      )
    }
    if (
      adapter.spec.id.startsWith('kanban_') ||
      registered.has(adapter.spec.id)
    ) {
      throw new Error(`Duplicate tool adapter '${adapter.spec.id}'`)
    }
    registered.set(adapter.spec.id, adapter)
  }
  return {
    describe(call) {
      if (!call.toolId.startsWith('kanban_')) {
        const adapter = registered.get(call.toolId)
        if (adapter !== undefined) return adapter.describe(call)
        if (fallback !== undefined) return fallback.describe(call)
        throw new Error(`Tool '${call.toolId}' is not registered`)
      }
      return {
        capability: `tool:${call.toolId}`,
        requirements: {
          readPaths: [],
          writePaths: [],
          networkTargets: [],
          commands: [],
          secretEnv: {},
        },
        expectedEffects: ['Update the durable Bee Kanban task state'],
        verification: ['Kanban event append succeeds'],
      }
    },
    async execute(call) {
      if (!call.call.toolId.startsWith('kanban_')) {
        const adapter = registered.get(call.call.toolId)
        if (adapter !== undefined) return adapter.execute(call)
        if (fallback !== undefined) return fallback.execute(call)
        throw new Error(`Tool '${call.call.toolId}' is not registered`)
      }
      try {
        const result = await executor.execute({
          toolId: call.call.toolId,
          input: call.call.input,
          context: {
            threadId: call.threadId,
            turnId: call.turnId,
            itemId: call.itemId,
          },
        })
        return {
          output: result.output,
          content: result.content,
          verification: ['Kanban event append succeeded'],
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          output: { error: message },
          content: message,
          isError: true,
          verification: [],
        }
      }
    },
    present(result, call) {
      if (!call.toolId.startsWith('kanban_')) {
        const adapter = registered.get(call.toolId)
        if (adapter?.present !== undefined) return adapter.present(result, call)
        if (fallback?.present !== undefined)
          return fallback.present(result, call)
      }
      return result
    },
  }
}

function assertUniqueToolIds(
  bindings: readonly { readonly id: string }[],
  label: string,
): void {
  const seen = new Set<string>()
  for (const binding of bindings) {
    if (seen.has(binding.id))
      throw new Error(`Duplicate ${label} '${binding.id}'`)
    seen.add(binding.id)
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
  const toolAdapters = options.toolAdapters ?? []
  const toolExecutor = compositeToolExecutor(
    options.kanban,
    toolAdapters,
    options.toolExecutor,
  )
  const toolSpecs = [
    ...KANBAN_TOOL_DEFINITIONS.map((definition) => ({
      id: definition.id,
      description: definition.description,
      inputSchema: definition.inputSchema,
    })),
    ...toolAdapters.map((adapter) => adapter.spec),
    ...(options.toolSpecs ?? []),
  ]
  assertUniqueToolIds(toolSpecs, 'tool spec')
  const toolAuthorization = [
    ...KANBAN_TOOL_DEFINITIONS.map((definition) => ({
      toolId: definition.id,
      decision: 'allow' as const,
      reason: 'Built-in local Kanban capability',
    })),
    ...toolAdapters.map((adapter) => adapter.authorization),
    ...(options.toolAuthorization ?? []),
  ]
  assertUniqueToolIds(
    toolAuthorization.map((rule) => ({ id: rule.toolId })),
    'tool authorization',
  )
  const runtime = await createBeeKernelRuntime({
    store,
    kanban: options.kanban,
    llm: options.llm,
    toolExecutor,
    sandboxProvider: options.sandboxProvider,
    secretBroker: options.secretBroker,
    toolAuthorization,
    toolSpecs,
    effectiveStructure: options.effectiveStructure,
    modelId: options.modelId,
    modelProviders: options.modelProviders,
    pluginCatalog: options.pluginCatalog,
    configSource: options.configSource,
    restoreActiveStructure: options.restoreActiveStructure,
  })
  const { kernel, loop, structures, configController } = runtime

  const corsOrigin = options.corsOrigin ?? loopbackOrigins

  const app = Fastify({ logger: options.logger ?? true })
  app.decorate('bee', {
    store,
    kanban: options.kanban,
    loop,
    kernel,
    structures,
    configController,
  })

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
  await app.register(structureRoutes)
  app.addHook('onClose', async () => {
    await runtime.stop()
    await store.close()
  })
  return {
    app,
    store,
    kanban: options.kanban,
    loop,
    kernel,
    structures,
    configController,
    reconcileStructure: (structure) => runtime.reconcile(structure),
  }
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
