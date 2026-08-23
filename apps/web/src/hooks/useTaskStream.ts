import { useEffect, useState } from 'react'
import type { AgentEvent } from '@bee-agent/contracts'
import type { BeeAgentClient } from '@bee-agent/client'

export interface TaskStreamState {
  readonly events: readonly AgentEvent[]
  /** True while the SSE connection is open (task not terminal yet). */
  readonly live: boolean
}

/**
 * Subscribes to a task's SSE stream from sequence zero: recorded events
 * replay first, then live events arrive. The stream aborts on task change or
 * unmount; the server closes it once the task reaches a terminal state.
 */
export function useTaskStream(
  client: BeeAgentClient,
  taskId: string | null,
): TaskStreamState {
  const [state, setState] = useState<TaskStreamState>({
    events: [],
    live: false,
  })

  useEffect(() => {
    if (!taskId) {
      setState({ events: [], live: false })
      return
    }
    const controller = new AbortController()
    setState({ events: [], live: true })
    void (async () => {
      try {
        for await (const event of client.streamEvents(taskId, {
          signal: controller.signal,
        })) {
          setState((previous) => ({
            events: [...previous.events, event],
            live: true,
          }))
        }
        setState((previous) => ({ ...previous, live: false }))
      } catch (error) {
        console.error(`event stream for task '${taskId}' failed`, error)
        setState((previous) => ({ ...previous, live: false }))
      }
    })()
    return () => controller.abort()
  }, [client, taskId])

  return state
}
