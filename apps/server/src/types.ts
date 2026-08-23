import type { Kernel } from '@bee-agent/kernel'
import type { MemoryRuntime, TaskRuntime } from '@bee-agent/runtime'

declare module 'fastify' {
  interface FastifyInstance {
    /** Server-wide handles composed by `buildServer`. */
    bee: {
      readonly kernel: Kernel
      readonly runtime: TaskRuntime
      /**
       * Workspace memory runtime. Its routes are only registered when a
       * Vector Store plugin is mounted; calling it otherwise stalls on the
       * `vector-store` service wait.
       */
      readonly memory: MemoryRuntime
    }
  }
}

export {}
