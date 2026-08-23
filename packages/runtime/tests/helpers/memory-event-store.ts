import { randomUUID } from 'node:crypto'
import { AgentEventSchema, NewAgentEventSchema } from '@bee-agent/contracts'
import type { AgentEvent, NewAgentEvent } from '@bee-agent/contracts'
import type { EventStore } from '@bee-agent/event-store'

/** In-memory Event Store fixture with per-task monotonic sequences. */
export class MemoryEventStore implements EventStore {
  readonly #events = new Map<string, AgentEvent[]>()

  append(event: NewAgentEvent): Promise<AgentEvent> {
    return this.appendBatch([event]).then((events) => events[0]!)
  }

  async appendBatch(events: readonly NewAgentEvent[]): Promise<AgentEvent[]> {
    const parsed = events.map((event) => NewAgentEventSchema.parse(event))
    const appended: AgentEvent[] = []
    for (const event of parsed) {
      const taskEvents = this.#events.get(event.taskId) ?? []
      const stored = AgentEventSchema.parse({
        ...event,
        id: randomUUID(),
        sequence: taskEvents.length + 1,
        createdAt: new Date().toISOString(),
      })
      taskEvents.push(stored)
      this.#events.set(event.taskId, taskEvents)
      appended.push(stored)
    }
    return appended
  }

  async *readTask(
    taskId: string,
    afterSequence = 0,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    for (const event of this.#events.get(taskId) ?? []) {
      if (event.sequence > afterSequence) yield event
    }
  }

  async getLatestSequence(taskId: string): Promise<number> {
    return (this.#events.get(taskId) ?? []).length
  }

  listTaskIds(): Promise<readonly string[]> {
    return Promise.resolve([...this.#events.keys()])
  }
}
