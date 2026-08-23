import type { AgentEvent, NewAgentEvent } from '@bee-agent/contracts'

export interface EventStore {
  append(event: NewAgentEvent): Promise<AgentEvent>
  appendBatch(events: readonly NewAgentEvent[]): Promise<AgentEvent[]>
  readTask(taskId: string, afterSequence?: number): AsyncIterable<AgentEvent>
  getLatestSequence(taskId: string): Promise<number>
  /** Ids of every task with recorded events, oldest first. */
  listTaskIds(): Promise<readonly string[]>
}
