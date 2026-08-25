import type { Kernel } from '@bee-agent/kernel'
import type { KanbanStore } from '@bee-agent/kanban'
import type { StructureReconciler } from '@bee-agent/runtime'
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
      readonly structures: StructureReconciler
    }
  }
}

export {}
