import type { Context, RuntimePlugin } from '@bee-agent/kernel'
import { AgentLoop } from './agent-loop.ts'
import type { AgentLoopOptions } from './agent-loop.ts'
import type { LlmRuntime } from './llm-runtime.ts'
import type { ChronicleStore } from '@bee-agent/knowledge'
import {
  ExecutionWorld,
  RoutingSandboxProvider,
  StaticAuthorizationPolicy,
  type SandboxProvider,
  type SecretBroker,
} from '@bee-agent/execution'
import {
  MODEL_REQUEST_SERVICE,
  ModelRequestService,
} from './model-request-service.ts'
import {
  InProcessToolSandbox,
  ToolExecutionService,
  type ToolAuthorizationRule,
  type ToolExecutionPort,
  type ToolExecutor,
} from './tool-execution.ts'

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
  readonly toolExecution: ToolExecutionPort
}

/** Canonical AgentLoop plugin; the Host supplies providers, not constructors. */
export function createAgentLoopPlugin(
  options: AgentLoopPluginOptions,
): RuntimePlugin {
  return {
    id: 'bee.agent-loop',
    version: options.version ?? '1.0.0',
    replacementTier: 'b',
    inject: ['chronicle', MODEL_REQUEST_SERVICE, 'toolExecution'],
    provides: [AGENT_LOOP_SERVICE],
    apply(ctx) {
      const services = ctx as AgentLoopPluginContext
      ctx.provide(
        AGENT_LOOP_SERVICE,
        new AgentLoop({
          store: services.chronicle,
          modelRequests: services.modelRequest,
          toolExecution: services.toolExecution,
          toolSpecs: options.toolSpecs,
        }),
      )
    },
  }
}

export interface ToolExecutionPluginOptions {
  readonly rules: readonly ToolAuthorizationRule[]
  readonly sandbox?: SandboxProvider | undefined
  readonly secrets?: SecretBroker | undefined
  readonly version?: string | undefined
}

interface ToolExecutionPluginContext extends Context {
  readonly chronicle: ChronicleStore
  readonly toolExecutor: ToolExecutor
}

export function createToolExecutionPlugin(
  options: ToolExecutionPluginOptions,
): RuntimePlugin {
  return {
    id: 'bee.tool-execution',
    version: options.version ?? '1.0.0',
    replacementTier: 'b',
    config: options.rules,
    inject: ['chronicle', 'toolExecutor'],
    provides: ['toolExecution'],
    apply(ctx) {
      const services = ctx as ToolExecutionPluginContext
      const logical = new InProcessToolSandbox(services.toolExecutor)
      const osSandbox = options.sandbox
      const sandbox =
        osSandbox === undefined
          ? logical
          : new RoutingSandboxProvider((request) => {
              const requirements = request.requirements
              const requiresOsBoundary =
                requirements.commands.length > 0 ||
                requirements.readPaths.length > 0 ||
                requirements.writePaths.length > 0 ||
                requirements.networkTargets.length > 0 ||
                Object.keys(requirements.secretEnv).length > 0
              return requiresOsBoundary ? osSandbox : logical
            })
      const world = new ExecutionWorld({
        store: services.chronicle,
        policy: new StaticAuthorizationPolicy(
          options.rules.map(({ toolId, ...decision }) => ({
            capability: `tool:${toolId}`,
            ...decision,
          })),
        ),
        sandbox,
        secrets: options.secrets,
      })
      ctx.provide(
        'toolExecution',
        new ToolExecutionService(world, services.toolExecutor),
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
