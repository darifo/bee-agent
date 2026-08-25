import type { Agent, AgentResult, AgentRunContext } from './agent.ts'
import type { ToolResult } from '@bee-agent/contracts'

export type MockAgentStep =
  | { readonly kind: 'say'; readonly content: string }
  | {
      readonly kind: 'tool'
      readonly toolId: string
      readonly input?: Record<string, unknown>
    }
  | { readonly kind: 'fail'; readonly message: string }

export interface MockAgentOptions {
  /** Defaults to `agent.mock`. */
  readonly id?: string
  /**
   * Steps executed in order. An empty script echoes the task input as a
   * single assistant message.
   */
  readonly script?: readonly MockAgentStep[]
}

export interface MockAgentOutput {
  readonly replies: readonly string[]
  readonly toolResults: readonly ToolResult[]
}

/**
 * Deterministic scripted agent used for tests, demos, and as the reference
 * implementation of the {@link Agent} contract. It checks for cancellation
 * between steps and reports replies and tool results as its output.
 */
export class MockAgent implements Agent {
  readonly id: string
  readonly #script: readonly MockAgentStep[]

  constructor(options: MockAgentOptions = {}) {
    this.id = options.id ?? 'agent.mock'
    this.#script = options.script ?? []
  }

  get script(): readonly MockAgentStep[] {
    return this.#script
  }

  async run(context: AgentRunContext): Promise<AgentResult> {
    const steps: readonly MockAgentStep[] =
      this.#script.length > 0
        ? this.#script
        : [{ kind: 'say', content: `Received: ${context.input}` }]
    const replies: string[] = []
    const toolResults: ToolResult[] = []
    for (const step of steps) {
      context.throwIfCancelled()
      if (step.kind === 'say') {
        await context.emitMessage('assistant', step.content)
        replies.push(step.content)
      } else if (step.kind === 'tool') {
        toolResults.push(await context.callTool(step.toolId, step.input ?? {}))
      } else {
        throw new Error(step.message)
      }
    }
    context.throwIfCancelled()
    return { output: { replies, toolResults } satisfies MockAgentOutput }
  }
}
