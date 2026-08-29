import type {
  ExecutionWorld,
  ActionRequest,
  ActionResult,
  AuthorizationDecision,
  ResourceRequirements,
  SandboxProvider,
} from '@bee-agent/execution'
import type { LlmToolCall, LlmToolSpec } from './llm-runtime.ts'

export interface ToolActionDescriptor {
  readonly capability: string
  readonly requirements: ResourceRequirements
  readonly expectedEffects: readonly string[]
  readonly verification: readonly string[]
}

export interface ToolExecutionCall {
  readonly call: LlmToolCall
  readonly threadId: string
  readonly turnId: string
  readonly itemId: string
  readonly structureVersion?: string | undefined
  readonly signal?: AbortSignal | undefined
}

export interface ToolExecutor {
  /** Expands model intent into the concrete resources and effects to authorize. */
  describe(call: LlmToolCall): ToolActionDescriptor
  execute(input: ToolExecutionCall): Promise<ActionResult>
  /** Deterministically maps a sandbox result into model-facing tool content. */
  present?(result: ActionResult, call: LlmToolCall): ActionResult
  /**
   * Whether this call may run alongside sibling calls from the same
   * generation. Absent means `exclusive`: tools opt into parallelism, they
   * are never assumed into it (fail-closed, like every benchmark agent).
   */
  concurrency?(call: LlmToolCall): ToolConcurrency
}

/** One coherent tool plugin binding: model schema, policy default, and resolver. */
export interface ToolAdapter extends ToolExecutor {
  readonly spec: LlmToolSpec
  readonly authorization: ToolAuthorizationRule
}

export type ToolExecutionOutcome =
  | { readonly kind: 'result'; readonly result: ActionResult }
  | {
      readonly kind: 'approval-required'
      readonly approvalId: string
      readonly title: string
      readonly detail: string
    }

export type ToolConcurrency = 'parallel' | 'exclusive'

export interface ToolExecutionPort {
  execute(
    input: ToolExecutionCall & {
      readonly approval?: 'approved' | 'rejected' | undefined
    },
  ): Promise<ToolExecutionOutcome>
  /** Concurrency class of one call; `exclusive` unless declared otherwise. */
  concurrency?(call: LlmToolCall): ToolConcurrency
}

export type ToolAuthorizationRule = AuthorizationDecision & {
  readonly toolId: string
}

/** In-process sandbox for logical tools that declare no OS isolation needs. */
export class InProcessToolSandbox implements SandboxProvider {
  readonly #executor: ToolExecutor

  constructor(executor: ToolExecutor) {
    this.#executor = executor
  }

  async execute(
    request: ActionRequest,
    options: { readonly signal?: AbortSignal | undefined },
  ): Promise<ActionResult> {
    const input = request.input as { call: LlmToolCall }
    return this.#executor.execute({
      call: input.call,
      threadId: request.scope.threadId,
      turnId: request.scope.turnId,
      itemId: request.scope.itemId ?? request.id,
      structureVersion: request.structureVersion,
      signal: options.signal,
    })
  }

  async snapshot(request: ActionRequest) {
    return {
      ref: `in-process:${request.scope.turnId}:${Date.now()}`,
      capturedAt: new Date().toISOString(),
    }
  }

  async diff() {
    return { kind: 'executor-reported' }
  }

  async capabilities() {
    return {
      provider: 'in-process-tool',
      filesystemIsolation: false,
      networkIsolation: false,
      processIsolation: false,
    }
  }
}

export class ToolExecutionService implements ToolExecutionPort {
  readonly #world: ExecutionWorld
  readonly #executor: ToolExecutor

  constructor(world: ExecutionWorld, executor: ToolExecutor) {
    this.#world = world
    this.#executor = executor
  }

  concurrency(call: LlmToolCall): ToolConcurrency {
    return this.#executor.concurrency?.(call) ?? 'exclusive'
  }

  async execute(
    input: ToolExecutionCall & {
      readonly approval?: 'approved' | 'rejected' | undefined
    },
  ): Promise<ToolExecutionOutcome> {
    const descriptor = this.#executor.describe(input.call)
    const request: ActionRequest = {
      id: input.itemId,
      idempotencyKey: `tool:${input.turnId}:${input.call.callId}`,
      capability: descriptor.capability,
      subject: { type: 'agent', id: 'bee' },
      input: { call: input.call },
      requirements: descriptor.requirements,
      expectedEffects: [...descriptor.expectedEffects],
      verification: [...descriptor.verification],
      scope: {
        threadId: input.threadId,
        turnId: input.turnId,
        itemId: input.itemId,
      },
      structureVersion: input.structureVersion,
    }
    const outcome = await this.#world.execute(request, {
      approval: input.approval,
      signal: input.signal,
    })
    if (outcome.kind === 'result') {
      return {
        kind: 'result',
        result:
          this.#executor.present?.(outcome.result, input.call) ??
          outcome.result,
      }
    }
    if (outcome.kind === 'approval-required') return outcome
    return {
      kind: 'result',
      result: {
        output: { error: outcome.reason },
        content: outcome.reason,
        isError: true,
        verification: [],
      },
    }
  }
}
