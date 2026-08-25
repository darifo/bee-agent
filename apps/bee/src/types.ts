import type { AgentLoop } from '@bee-agent/runtime'
import type { BroadcastingChronicleStore } from './broadcasting-store.js'

declare module 'fastify' {
  interface FastifyInstance {
    /** Host-wide handles composed by `buildBeeServer`. */
    bee: {
      readonly store: BroadcastingChronicleStore
      readonly loop: AgentLoop
    }
  }
}

export {}
