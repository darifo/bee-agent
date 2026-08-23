import type { Kernel } from '@bee-agent/kernel'
import type { TaskRuntime } from '@bee-agent/runtime'

declare module 'fastify' {
  interface FastifyInstance {
    /** Server-wide handles composed by `buildServer`. */
    bee: {
      readonly kernel: Kernel
      readonly runtime: TaskRuntime
    }
  }
}

export {}
