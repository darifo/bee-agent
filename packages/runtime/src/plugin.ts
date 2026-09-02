import type { Context, RuntimePlugin } from '@bee-agent/kernel'
import { AgentLoop } from './agent-loop.ts'
import type { AgentLoopOptions } from './agent-loop.ts'
import type { LlmRuntime } from './llm-runtime.ts'
import type { ChronicleStore } from '@bee-agent/knowledge'
import {
  ExecutionWorld,
  IntersectionAuthorizationPolicy,
  RoutingSandboxProvider,
  type SandboxProvider,
  type SecretBroker,
  PersistedGrantPolicy,
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
  'toolSpecs' | 'hooks' | 'systemPrompt'
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
          ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
          ...(options.systemPrompt === undefined
            ? {}
            : { systemPrompt: options.systemPrompt }),
        }),
      )
    },
  }
}

export interface ToolExecutionPluginOptions {
  /**
   * Durable user grants: remembered approvals relax this plugin's `ask`
   * decisions to `allow` for the granted capabilities. `deny` is never
   * overridden. The set is live — grants recorded at runtime take effect
   * on the next action without a structure rebuild.
   */
  readonly persistedGrants?: ReadonlySet<string> | undefined
  readonly rules: readonly ToolAuthorizationRule[]
  readonly structureGrants?: readonly string[] | undefined
  readonly hardDenies?: readonly string[] | undefined
  readonly userGrants?: readonly string[] | undefined
  readonly pluginDeclarations?: readonly string[] | undefined
  readonly taskScope?: readonly string[] | undefined
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
    config: {
      rules: options.rules,
      structureGrants: options.structureGrants ?? [],
      hardDenies: options.hardDenies ?? [],
      userGrants: options.userGrants ?? [],
      pluginDeclarations: options.pluginDeclarations ?? [],
      taskScope: options.taskScope ?? [],
    },
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
      const intersection = new IntersectionAuthorizationPolicy([
        {
          id: 'hard-safety',
          rules: [
            ...(options.hardDenies ?? []).map((capability) => ({
              capability,
              decision: 'deny' as const,
              reason: 'Capability is blocked by immutable hard safety',
            })),
            {
              capability: '*',
              decision: 'allow',
              reason: 'No immutable hard deny matched',
            },
          ],
        },
        {
          id: 'structure-grant',
          rules: (options.structureGrants ?? []).map((capability) => ({
            capability,
            decision: 'allow' as const,
            reason: 'Capability is granted by the active Structure',
          })),
        },
        ...[
          ['user-grant', options.userGrants],
          ['plugin-declaration', options.pluginDeclarations],
          ['task-scope', options.taskScope],
        ].map(([id, configured]) => ({
          id: id as string,
          rules: (
            (configured as readonly string[] | undefined) ??
            options.rules.map(({ toolId }) => `tool:${toolId}`)
          ).map((capability) => ({
            capability,
            decision: 'allow' as const,
            reason: `${id} includes the enabled tool`,
          })),
        })),
        {
          id: 'bee-policy',
          rules: options.rules.map(({ toolId, ...decision }) => ({
            capability: `tool:${toolId}`,
            ...decision,
          })),
        },
      ])
      const world = new ExecutionWorld({
        store: services.chronicle,
        policy:
          options.persistedGrants === undefined
            ? intersection
            : new PersistedGrantPolicy(intersection, options.persistedGrants),
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
