import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { EventStore } from '@bee-agent/event-store'
import {
  createKernel,
  eventStoreService,
  storageService,
} from '@bee-agent/kernel'
import { SQLiteStoragePlugin } from '@bee-agent/plugin-storage-sqlite'
import { CalculatorTool } from '@bee-agent/plugin-tool-calculator'
import { MockAgent, TaskRuntime } from '@bee-agent/runtime'
import type { Agent, Tool, ToolPolicy } from '@bee-agent/runtime'
import { approvalRoutes } from './routes/approvals.js'
import { streamRoutes } from './routes/stream.js'
import { taskRoutes } from './routes/tasks.js'
import { sendErrorResponse } from './errors.js'

export interface ServerOptions {
  /** SQLite database file; `:memory:` keeps everything in RAM. */
  readonly sqliteFilename?: string | undefined
  /** Agent used when a task spec references an unregistered `agentId`. */
  readonly defaultAgent?: Agent | undefined
  /** Tools seeded into the runtime; defaults to the calculator tool. */
  readonly tools?: readonly Tool[] | undefined
  /** Policies seeded into the runtime's policy engine. */
  readonly policies?: readonly ToolPolicy[] | undefined
  /** Event Store override for tests; skips mounting the SQLite plugin. */
  readonly eventStore?: EventStore | undefined
  /** Fastify logger toggle (enabled by default). */
  readonly logger?: boolean | undefined
}

export interface BeeServer {
  readonly app: FastifyInstance
  readonly kernel: ReturnType<typeof createKernel>
  readonly runtime: TaskRuntime
}

/**
 * Composition root: starts the kernel, mounts storage (SQLite by default,
 * registered under the standard `event-store` and `storage` service keys),
 * wires the task runtime with the mock agent and calculator tool, and serves
 * the REST + SSE API.
 */
export async function buildServer(
  options: ServerOptions = {},
): Promise<BeeServer> {
  const kernel = createKernel()
  await kernel.start()
  if (options.eventStore) {
    kernel.registerService(eventStoreService, options.eventStore)
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
  const runtime = new TaskRuntime(kernel, {
    defaultAgent: options.defaultAgent ?? new MockAgent(),
    tools: options.tools ?? [new CalculatorTool()],
    policies: options.policies ?? [],
  })

  const app = Fastify({ logger: options.logger ?? true })
  app.decorate('bee', { kernel, runtime })
  app.setErrorHandler(async (error, request, reply) => {
    await sendErrorResponse(error, request, reply)
  })
  app.get('/health', async () => ({ status: 'ok' }))
  await app.register(taskRoutes)
  await app.register(approvalRoutes)
  await app.register(streamRoutes)
  app.addHook('onClose', async () => {
    await kernel.stop()
  })
  return { app, kernel, runtime }
}
