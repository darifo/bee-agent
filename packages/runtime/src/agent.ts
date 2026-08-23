import type { ToolResult } from '@bee-agent/contracts'
import type { ToolRegistry } from './tool.js'

/**
 * Context a task runtime hands to an agent for one task run. Agents drive the
 * loop: they emit messages, call tools, and observe cancellation between
 * steps. Lifecycle events (`task.*`) are reserved for the runtime.
 */
export interface AgentRunContext {
  readonly taskId: string
  readonly input: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly workspaceId: string | undefined
  /** Tools visible to this run. */
  readonly tools: ToolRegistry
  /** Whether the task was cancelled; check between steps. */
  readonly cancelled: boolean
  /** Throws {@link TaskCancelledError} when the task was cancelled. */
  throwIfCancelled(): void
  /** Appends a custom agent event; runtime-reserved types are rejected. */
  emit(type: string, payload: Record<string, unknown>): Promise<void>
  /** Appends an `agent.message` event. */
  emitMessage(role: string, content: string): Promise<void>
  /** Runs a tool through the policy-intercepted execution pipeline. */
  callTool(toolId: string, input: Record<string, unknown>): Promise<ToolResult>
}

export interface AgentResult {
  readonly output?: unknown
}

export interface Agent {
  readonly id: string
  run(context: AgentRunContext): Promise<AgentResult>
}

/** Error subclass used to unwind an agent loop after task cancellation. */
export class TaskCancelledError extends Error {
  constructor(
    readonly taskId: string,
    readonly reason: string | undefined,
  ) {
    super(
      reason === undefined
        ? `Task '${taskId}' was cancelled`
        : `Task '${taskId}' was cancelled: ${reason}`,
    )
    this.name = 'TaskCancelledError'
  }
}
