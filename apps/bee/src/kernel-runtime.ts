import type { ChronicleStore } from '@bee-agent/knowledge'
import type { KanbanStore } from '@bee-agent/kanban'
import {
  createKernel,
  type RuntimePlugin,
  type GenerationLease,
  type Kernel,
} from '@bee-agent/kernel'
import type {
  AgentLoopRecoverInput,
  AgentLoopResumeInput,
  AgentLoopRunInput,
  AgentLoopToolSlot,
  AgentLoopTurnResult,
  LlmRuntime,
  LlmToolSpec,
} from '@bee-agent/runtime'
import { AGENT_LOOP_SERVICE, createAgentLoopPlugin } from '@bee-agent/runtime'

export interface AgentLoopService {
  runTurn(input: AgentLoopRunInput): Promise<AgentLoopTurnResult>
  recoverTurn(input: AgentLoopRecoverInput): Promise<AgentLoopTurnResult>
  resumeTurn(input: AgentLoopResumeInput): Promise<AgentLoopTurnResult>
}

export interface BeeKernelRuntimeOptions {
  readonly store: ChronicleStore
  readonly kanban: KanbanStore
  readonly llm: LlmRuntime
  readonly tools: AgentLoopToolSlot
  readonly toolSpecs: readonly LlmToolSpec[]
  readonly structureVersion?: string | undefined
}

export interface BeeKernelRuntime {
  readonly kernel: Kernel
  readonly loop: AgentLoopService
  stop(): Promise<void>
}

/**
 * Keeps a generation lease across an approval suspension. A live Turn never
 * switches model/tool/runtime providers midway through configuration reload.
 */
class PinnedAgentLoop implements AgentLoopService {
  readonly #kernel: Kernel
  readonly #suspended = new Map<string, GenerationLease>()

  constructor(kernel: Kernel) {
    this.#kernel = kernel
  }

  async runTurn(input: AgentLoopRunInput): Promise<AgentLoopTurnResult> {
    const lease = this.#kernel.beginTurn()
    try {
      const result = await lease
        .service<AgentLoopService>(AGENT_LOOP_SERVICE)
        .runTurn({
          ...input,
          structureVersion: lease.structureVersion,
        })
      this.#settleLease(result, lease)
      return result
    } catch (error) {
      lease.release()
      throw error
    }
  }

  async recoverTurn(
    input: AgentLoopRecoverInput,
  ): Promise<AgentLoopTurnResult> {
    const lease = this.#suspended.get(input.turnId) ?? this.#kernel.beginTurn()
    try {
      const result = await lease
        .service<AgentLoopService>(AGENT_LOOP_SERVICE)
        .recoverTurn(input)
      this.#settleLease(result, lease)
      return result
    } catch (error) {
      if (!this.#suspended.has(input.turnId)) lease.release()
      throw error
    }
  }

  async resumeTurn(input: AgentLoopResumeInput): Promise<AgentLoopTurnResult> {
    const held = this.#suspended.get(input.turnId)
    const lease = held ?? this.#kernel.beginTurn()
    try {
      const result = await lease
        .service<AgentLoopService>(AGENT_LOOP_SERVICE)
        .resumeTurn(input)
      this.#settleLease(result, lease)
      return result
    } catch (error) {
      if (held === undefined) lease.release()
      throw error
    }
  }

  stop(): void {
    for (const lease of this.#suspended.values()) lease.release()
    this.#suspended.clear()
  }

  #settleLease(result: AgentLoopTurnResult, lease: GenerationLease): void {
    if (result.status === 'suspended') {
      const previous = this.#suspended.get(result.turn.id)
      if (previous !== undefined && previous !== lease) previous.release()
      this.#suspended.set(result.turn.id, lease)
      return
    }
    this.#suspended.delete(result.turn.id)
    lease.release()
  }
}

function servicePlugin(
  id: string,
  serviceName: string,
  value: unknown,
): RuntimePlugin {
  return {
    id,
    version: '1.0.0',
    provides: [serviceName],
    apply(ctx) {
      ctx.provide(serviceName, value)
    },
  }
}

/**
 * Builds the real Host runtime as a Cordis-managed plugin graph. Model,
 * tools, Chronicle, Kanban and AgentLoop are services rather than privileged
 * objects wired directly into Fastify.
 */
export async function createBeeKernelRuntime(
  options: BeeKernelRuntimeOptions,
): Promise<BeeKernelRuntime> {
  const kernel = createKernel()
  const plugins: RuntimePlugin[] = [
    servicePlugin('bee.chronicle', 'chronicle', options.store),
    servicePlugin('bee.kanban', 'kanban', options.kanban),
    servicePlugin('bee.model', 'llm', options.llm),
    servicePlugin('bee.tools', 'tools', options.tools),
    createAgentLoopPlugin({ toolSpecs: options.toolSpecs }),
  ]
  const result = await kernel.reconcile({
    structureVersion: options.structureVersion ?? 'bee:host:default-v1',
    plugins,
  })
  if (result.kind === 'restart-required') {
    throw new Error('Initial Bee Host generation unexpectedly requires restart')
  }
  const loop = new PinnedAgentLoop(kernel)
  return {
    kernel,
    loop,
    async stop() {
      loop.stop()
      await kernel.stop()
    },
  }
}
