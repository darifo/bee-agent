import type { Kernel } from '@bee-agent/kernel'
import type { KanbanStore } from '@bee-agent/kanban'
import type { BroadcastingChronicleStore } from './broadcasting-store.ts'
import type { AgentLoopService } from './kernel-runtime.ts'

declare module 'fastify' {
  interface FastifyInstance {
    /** Host-wide handles composed by `buildBeeServer`. */
    bee: {
      readonly store: BroadcastingChronicleStore
      readonly kanban: KanbanStore
      readonly loop: AgentLoopService
      readonly kernel: Kernel
    }
  }
}

export {}
