import { BeeAgentClient } from '@bee-agent/client'
import type { Agent, AgentResult, AgentRunContext } from '@bee-agent/runtime'
import { TaskCancelledError } from '@bee-agent/runtime'

export interface RemoteAgentOptions {
  /** Agent id this adapter is registered under locally. */
  readonly id: string
  /** Base URL of the remote Bee Agent server. */
  readonly baseUrl: string | URL
  /**
   * `agentId` the remote server should use for the delegated task;
   * defaults to `agent.mock` (the remote's default-agent fallback applies
   * for unregistered ids).
   */
  readonly remoteAgentId?: string | undefined
}

/**
 * Federation adapter (ADR 0016): delegates a task run to another Bee Agent
 * server over the Client SDK. Remote `agent.message` events are re-emitted
 * locally as the stream arrives, so the local event log mirrors the remote
 * conversation; cancellation propagates to the remote task; the remote
 * result becomes this agent's output.
 */
export class RemoteAgent implements Agent {
  readonly id: string
  readonly #client: BeeAgentClient
  readonly #remoteAgentId: string

  constructor(options: RemoteAgentOptions) {
    this.id = options.id
    this.#client = new BeeAgentClient({ baseUrl: options.baseUrl })
    this.#remoteAgentId = options.remoteAgentId ?? 'agent.mock'
  }

  async run(context: AgentRunContext): Promise<AgentResult> {
    const { task } = await this.#client.createTask({
      input: context.input,
      agentId: this.#remoteAgentId,
      metadata: { ...context.metadata, delegatedBy: this.id },
    })

    let finalSnapshot
    try {
      // POST run answers 202 with the starting snapshot; the event stream
      // closes when the remote task reaches a terminal state, and the final
      // snapshot carries the result.
      await this.#client.runTask(task.id)
      for await (const event of this.#client.streamEvents(task.id)) {
        context.throwIfCancelled()
        if (event.type === 'agent.message') {
          const payload = event.payload as { role: string; content: string }
          await context.emitMessage(payload.role, payload.content)
        }
      }
      finalSnapshot = await this.#client.getTask(task.id)
    } catch (error) {
      if (error instanceof TaskCancelledError) {
        // Propagate the cancellation so the remote task does not linger.
        await this.#client
          .cancelTask(task.id, 'local task cancelled')
          .catch(() => undefined)
      }
      throw error
    }
    return { output: finalSnapshot.result }
  }
}
