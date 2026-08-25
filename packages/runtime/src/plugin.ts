import type { Context, RuntimePlugin } from '@bee-agent/kernel'
import { AgentLoop } from './agent-loop.ts'
import type { AgentLoopOptions } from './agent-loop.ts'
import type { LlmRuntime } from './llm-runtime.ts'
import type { ChronicleStore } from '@bee-agent/knowledge'
import type { AgentLoopToolSlot } from './agent-loop.ts'

export const AGENT_LOOP_SERVICE = 'agentLoop'

export interface AgentLoopPluginOptions extends Pick<
  AgentLoopOptions,
  'toolSpecs'
> {
  readonly version?: string | undefined
}

interface AgentLoopPluginContext extends Context {
  readonly chronicle: ChronicleStore
  readonly llm: LlmRuntime
  readonly tools: AgentLoopToolSlot
}

/** Canonical AgentLoop plugin; the Host supplies providers, not constructors. */
export function createAgentLoopPlugin(
  options: AgentLoopPluginOptions,
): RuntimePlugin {
  return {
    id: 'bee.agent-loop',
    version: options.version ?? '1.0.0',
    replacementTier: 'b',
    inject: ['chronicle', 'llm', 'tools'],
    provides: [AGENT_LOOP_SERVICE],
    apply(ctx) {
      const services = ctx as AgentLoopPluginContext
      ctx.provide(
        AGENT_LOOP_SERVICE,
        new AgentLoop({
          store: services.chronicle,
          llm: services.llm,
          tools: services.tools,
          toolSpecs: options.toolSpecs,
        }),
      )
    },
  }
}
