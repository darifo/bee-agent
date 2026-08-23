import type { ToolCall, ToolManifest, ToolResult } from '@bee-agent/contracts'
import { defineWaterfallEvent } from '@bee-agent/kernel'
import type { WaterfallMiddleware } from '@bee-agent/kernel'

/** Context handed to a tool when the runtime invokes it. */
export interface ToolInvokeContext {
  readonly taskId: string
  readonly callId: string
}

/**
 * A capability exposed to agents. `input` is the validated `arguments` record
 * of the originating {@link ToolCall}; returned values become the tool result
 * output, while thrown errors become tool result errors instead of failing
 * the task.
 */
export interface Tool {
  readonly manifest: ToolManifest
  execute(
    input: Record<string, unknown>,
    context: ToolInvokeContext,
  ): unknown | Promise<unknown>
}

export class UnknownToolError extends Error {
  constructor(readonly toolId: string) {
    super(`Unknown tool '${toolId}'`)
    this.name = 'UnknownToolError'
  }
}

/** Mutable registry of tools available to a runtime or a single task run. */
export class ToolRegistry {
  readonly #tools = new Map<string, Tool>()

  register(tool: Tool): this {
    this.#tools.set(tool.manifest.id, tool)
    return this
  }

  has(toolId: string): boolean {
    return this.#tools.has(toolId)
  }

  get(toolId: string): Tool | undefined {
    return this.#tools.get(toolId)
  }

  /** Returns the tool or throws {@link UnknownToolError}. */
  require(toolId: string): Tool {
    const tool = this.#tools.get(toolId)
    if (!tool) throw new UnknownToolError(toolId)
    return tool
  }

  list(): readonly Tool[] {
    return [...this.#tools.values()]
  }

  manifests(): readonly ToolManifest[] {
    return this.list().map((tool) => tool.manifest)
  }

  /** Returns an independent registry seeded with the same tools. */
  clone(): ToolRegistry {
    const registry = new ToolRegistry()
    for (const tool of this.#tools.values()) registry.register(tool)
    return registry
  }
}

/** Creates a failed tool result carrying `error`. */
export function failedToolResult(callId: string, error: string): ToolResult {
  return { callId, output: undefined, error }
}

/** Input for {@link ToolExecutionHooks.requestApproval}. */
export interface ApprovalRequestInput {
  readonly call: ToolCall
  readonly reason: string
  readonly risk: 'low' | 'medium' | 'high'
  readonly expiresAt?: string
}

/** Runtime hooks available to tool execution middleware. */
export interface ToolExecutionHooks {
  /**
   * Suspends the task until an approval decision arrives; resolves with the
   * decision (`true` = approved).
   */
  requestApproval(input: ApprovalRequestInput): Promise<boolean>
}

/** Payload flowing through the `tools/execute` waterfall. */
export interface ToolExecutionContext {
  readonly call: ToolCall
  readonly tool: Tool
  readonly hooks: ToolExecutionHooks
}

/**
 * Tool execution interception pipeline. Middleware may short-circuit with a
 * failed {@link ToolResult} (policy denial) or suspend the task for an
 * approval decision before letting the terminal implementation run the tool.
 */
export const toolExecuteEvent = defineWaterfallEvent<
  ToolExecutionContext,
  ToolResult
>('tools/execute')

export type ToolExecuteMiddleware = WaterfallMiddleware<
  ToolExecutionContext,
  ToolResult
>
