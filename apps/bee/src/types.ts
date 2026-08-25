import type { AgentLoop } from '@bee-agent/runtime'
import type { KanbanStore } from '@bee-agent/kanban'
import type { BroadcastingChronicleStore } from './broadcasting-store.ts'

declare module 'fastify' {
  interface FastifyInstance {
    /** Host-wide handles composed by `buildBeeServer`. */
    bee: {
      readonly store: BroadcastingChronicleStore
      readonly kanban: KanbanStore
      readonly loop: AgentLoop
    }
  }
}

export {}
