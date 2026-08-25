import type { ToolCall, ToolManifest } from '@bee-agent/contracts'
import type { ToolExecuteMiddleware } from './tool.ts'
import { failedToolResult } from './tool.ts'

export type ApprovalRisk = 'low' | 'medium' | 'high'

export type PolicyDecision =
  | { readonly effect: 'allow' }
  | { readonly effect: 'deny'; readonly reason: string }
  | {
      readonly effect: 'approval'
      readonly reason: string
      readonly risk?: ApprovalRisk
      /** ISO timestamp after which the request is decided as denied. */
      readonly expiresAt?: string
    }

export interface PolicyCheckInput {
  readonly taskId: string
  readonly call: ToolCall
  readonly manifest: ToolManifest
}

/** A named rule evaluated before a tool call executes. */
export interface ToolPolicy {
  readonly id: string
  checkToolCall(input: PolicyCheckInput): PolicyDecision
}

/**
 * Evaluates registered policies in order; the first decisive decision (deny
 * or approval) wins. Absent any decisive decision, tool calls are allowed.
 */
export class PolicyEngine {
  readonly #policies: ToolPolicy[] = []

  constructor(policies: readonly ToolPolicy[] = []) {
    for (const policy of policies) this.register(policy)
  }

  register(policy: ToolPolicy): this {
    this.#policies.push(policy)
    return this
  }

  get policies(): readonly ToolPolicy[] {
    return [...this.#policies]
  }

  evaluate(input: PolicyCheckInput): PolicyDecision {
    for (const policy of this.#policies) {
      const decision = policy.checkToolCall(input)
      if (decision.effect !== 'allow') return decision
    }
    return { effect: 'allow' }
  }
}

/** Adapts a {@link PolicyEngine} into `tools/execute` waterfall middleware. */
export function toolPolicyMiddleware(
  engine: PolicyEngine,
): ToolExecuteMiddleware {
  return async (payload, next) => {
    const decision = engine.evaluate({
      taskId: payload.call.taskId,
      call: payload.call,
      manifest: payload.tool.manifest,
    })
    if (decision.effect === 'deny') {
      return failedToolResult(
        payload.call.id,
        `Tool call denied by policy: ${decision.reason}`,
      )
    }
    if (decision.effect === 'approval') {
      const approved = await payload.hooks.requestApproval({
        call: payload.call,
        reason: decision.reason,
        risk: decision.risk ?? 'medium',
        ...(decision.expiresAt !== undefined
          ? { expiresAt: decision.expiresAt }
          : {}),
      })
      if (!approved) {
        return failedToolResult(
          payload.call.id,
          `Tool call not approved: ${decision.reason}`,
        )
      }
    }
    return next(payload)
  }
}

export interface ToolAllowlistOptions {
  /** Tool ids that may run; every other tool is denied. */
  readonly allowed: readonly string[]
  readonly id?: string
}

/** Denies every tool call outside the configured allowlist. */
export function createToolAllowlistPolicy(
  options: ToolAllowlistOptions,
): ToolPolicy {
  const allowed = new Set(options.allowed)
  return {
    id: options.id ?? 'policy.tool-allowlist',
    checkToolCall({ call }) {
      if (allowed.has(call.toolId)) return { effect: 'allow' }
      return {
        effect: 'deny',
        reason: `tool '${call.toolId}' is not in the allowlist`,
      }
    },
  }
}

export interface ToolApprovalPolicyOptions {
  /** Tool ids that require an approval decision, mapped to their risk level. */
  readonly approvals: Readonly<Record<string, ApprovalRisk>>
  readonly id?: string
}

/** Requires an approval decision for the listed tools; others are allowed. */
export function createToolApprovalPolicy(
  options: ToolApprovalPolicyOptions,
): ToolPolicy {
  return {
    id: options.id ?? 'policy.tool-approval',
    checkToolCall({ call }) {
      const risk = options.approvals[call.toolId]
      if (risk === undefined) return { effect: 'allow' }
      return {
        effect: 'approval',
        reason: `tool '${call.toolId}' is classified as risk '${risk}'`,
        risk,
      }
    },
  }
}
