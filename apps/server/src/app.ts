import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import type { EventStore } from '@bee-agent/event-store'
import type { Kernel } from '@bee-agent/kernel'
import {
  createKernel,
  eventStoreService,
  storageService,
  vectorStoreService,
} from '@bee-agent/kernel'
import { PgvectorPlugin } from '@bee-agent/plugin-vector-pgvector'
import { SQLiteStoragePlugin } from '@bee-agent/plugin-storage-sqlite'
import { PostgresStoragePlugin } from '@bee-agent/plugin-storage-postgres'
import { CalculatorTool } from '@bee-agent/plugin-tool-calculator'
import { MemoryRuntime, MockAgent, TaskRuntime } from '@bee-agent/runtime'
import type { Agent, Embedder, Tool, ToolPolicy } from '@bee-agent/runtime'
import { approvalRoutes } from './routes/approvals.js'
import { memoryRoutes } from './routes/memory.js'
import { streamRoutes } from './routes/stream.js'
import { taskRoutes } from './routes/tasks.js'
import { sendErrorResponse } from './errors.js'

export interface ServerOptions {
  /** SQLite database file; `:memory:` keeps everything in RAM. */
  readonly sqliteFilename?: string | undefined
  /**
   * PostgreSQL connection string. When set, PostgreSQL is the active
   * storage dialect and SQLite stays unmounted — one dialect per
   * instance, never dual writes (ADR 0004).
   */
  readonly postgresUrl?: string | undefined
  /**
   * Mounts a Vector Store plugin under the `vector-store` service key.
   * Currently `'pgvector'`, which requires `postgresUrl`: its manifest
   * depends on PostgreSQL storage, and vectors never enter event tables
   * (ADR 0005/0006).
   */
  readonly vectorStore?: 'pgvector' | undefined
  /** Agent used when a task spec references an unregistered `agentId`. */
  readonly defaultAgent?: Agent | undefined
  /**
   * Embedder for the memory runtime; defaults to the deterministic mock
   * until a real provider is configured.
   */
  readonly embedder?: Embedder | undefined
  /** Tools seeded into the runtime; defaults to the calculator tool. */
  readonly tools?: readonly Tool[] | undefined
  /** Policies seeded into the runtime's policy engine. */
  readonly policies?: readonly ToolPolicy[] | undefined
  /** Event Store override for tests; skips mounting the SQLite plugin. */
  readonly eventStore?: EventStore | undefined
  /** Fastify logger toggle (enabled by default). */
  readonly logger?: boolean | undefined
  /**
   * Allowed CORS origins for browser clients; `true` (the default for this
   * engineering preview) reflects any origin.
   */
  readonly corsOrigin?: boolean | string[] | undefined
}

export interface BeeServer {
  readonly app: FastifyInstance
  readonly kernel: Kernel
  readonly runtime: TaskRuntime
  readonly memory: MemoryRuntime
}

/**
 * Composition root: starts the kernel, mounts storage (SQLite by default or
 * PostgreSQL via `postgresUrl`, registered under the standard `event-store`
 * and `storage` service keys), optionally mounts a Vector Store plugin
 * (`vectorStore: 'pgvector'` under the `vector-store` service key), wires
 * the task runtime with the mock agent and calculator tool, and serves the
 * REST + SSE API.
 */
export async function buildServer(
  options: ServerOptions = {},
): Promise<BeeServer> {
  const postgresUrl = options.postgresUrl
  if (postgresUrl !== undefined && options.sqliteFilename !== undefined) {
    throw new Error(
      'Configure either sqliteFilename or postgresUrl, never both: one storage dialect per instance (ADR 0004)',
    )
  }
  if (options.vectorStore === 'pgvector' && postgresUrl === undefined) {
    throw new Error(
      'vectorStore "pgvector" requires postgresUrl: it mounts on PostgreSQL storage (ADR 0005)',
    )
  }

  const kernel = createKernel()
  await kernel.start()
  if (options.eventStore) {
    kernel.registerService(eventStoreService, options.eventStore)
  } else if (postgresUrl !== undefined) {
    const storage = new PostgresStoragePlugin({
      connectionString: postgresUrl,
    })
    const handle = kernel.useBeeAgentPlugin(storage, {
      services: () => ({
        [eventStoreService.name]: storage.eventStore,
        [storageService.name]: storage.storage,
      }),
    })
    await handle.ready
  } else {
    const storage = new SQLiteStoragePlugin({
      filename: options.sqliteFilename ?? 'bee-agent.sqlite',
    })
    const handle = kernel.useBeeAgentPlugin(storage, {
      services: () => ({
        [eventStoreService.name]: storage.eventStore,
        [storageService.name]: storage.storage,
      }),
    })
    await handle.ready
  }
  if (options.vectorStore === 'pgvector') {
    if (postgresUrl === undefined) {
      throw new Error(
        'vectorStore "pgvector" requires postgresUrl: it mounts on PostgreSQL storage (ADR 0005)',
      )
    }
    const vectorPlugin = new PgvectorPlugin({
      connectionString: postgresUrl,
    })
    const handle = kernel.useBeeAgentPlugin(vectorPlugin, {
      services: () => ({ [vectorStoreService.name]: vectorPlugin.store }),
    })
    await handle.ready
  }
  const runtime = new TaskRuntime(kernel, {
    defaultAgent: options.defaultAgent ?? new MockAgent(),
    tools: options.tools ?? [new CalculatorTool()],
    policies: options.policies ?? [],
  })
  const memory = new MemoryRuntime(
    kernel,
    options.embedder === undefined ? {} : { embedder: options.embedder },
  )

  const app = Fastify({ logger: options.logger ?? true })
  app.decorate('bee', { kernel, runtime, memory })
  await app.register(cors, {
    origin: options.corsOrigin ?? true,
    methods: ['GET', 'POST', 'DELETE'],
  })
  app.setErrorHandler(async (error, request, reply) => {
    await sendErrorResponse(error, request, reply)
  })
  app.get('/health', async () => ({ status: 'ok' }))
  await app.register(taskRoutes)
  await app.register(approvalRoutes)
  if (options.vectorStore !== undefined) {
    // Memory rides on the Vector Store (ADR 0005): no vector plugin, no
    // memory surface — the paths 404 instead of stalling on the service.
    await app.register(memoryRoutes)
  }
  await app.register(streamRoutes, {
    corsOrigin: options.corsOrigin ?? true,
  })
  app.addHook('onClose', async () => {
    await kernel.stop()
  })
  return { app, kernel, runtime, memory }
}
