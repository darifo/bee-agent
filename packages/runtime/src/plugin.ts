import type { Context, RuntimePlugin } from '@bee-agent/kernel'
import { AgentLoop } from './agent-loop.ts'
import type { AgentLoopOptions } from './agent-loop.ts'
import type { LlmRuntime } from './llm-runtime.ts'
import type { ChronicleStore } from '@bee-agent/knowledge'
import type { AgentLoopToolSlot } from './agent-loop.ts'
import {
  MODEL_REQUEST_SERVICE,
  ModelRequestService,
} from './model-request-service.ts'

export const AGENT_LOOP_SERVICE = 'agentLoop'

export interface AgentLoopPluginOptions extends Pick<
  AgentLoopOptions,
  'toolSpecs'
> {
  readonly version?: string | undefined
}

interface AgentLoopPluginContext extends Context {
  readonly chronicle: ChronicleStore
  readonly modelRequest: ModelRequestService
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
    inject: ['chronicle', MODEL_REQUEST_SERVICE, 'tools'],
    provides: [AGENT_LOOP_SERVICE],
    apply(ctx) {
      const services = ctx as AgentLoopPluginContext
      ctx.provide(
        AGENT_LOOP_SERVICE,
        new AgentLoop({
          store: services.chronicle,
          modelRequests: services.modelRequest,
          tools: services.tools,
          toolSpecs: options.toolSpecs,
        }),
      )
    },
  }
}

export interface ModelRequestPluginOptions {
  readonly promptVersion: string
  readonly structureVersion: string
  readonly tokenBudget?: number | undefined
  readonly version?: string | undefined
}

interface ModelRequestPluginContext extends Context {
  readonly chronicle: ChronicleStore
  readonly llm: LlmRuntime
}

/** Owns manifest persistence and the only direct LLMRuntime call boundary. */
export function createModelRequestPlugin(
  options: ModelRequestPluginOptions,
): RuntimePlugin {
  return {
    id: 'bee.model-request',
    version: options.version ?? '1.0.0',
    replacementTier: 'b',
    config: options,
    inject: ['chronicle', 'llm'],
    provides: [MODEL_REQUEST_SERVICE],
    apply(ctx) {
      const services = ctx as ModelRequestPluginContext
      ctx.provide(
        MODEL_REQUEST_SERVICE,
        new ModelRequestService({
          store: services.chronicle,
          llm: services.llm,
          promptVersion: options.promptVersion,
          structureVersion: options.structureVersion,
          tokenBudget: options.tokenBudget,
        }),
      )
    },
  }
}
