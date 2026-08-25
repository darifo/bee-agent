import { useEffect, useState } from 'react'
import type { ThreadEvent } from '@bee-agent/thread/protocol'
import type { BeeAgentClient } from '@bee-agent/client'

export interface ThreadStreamState {
  readonly events: readonly ThreadEvent[]
  /** True while the SSE connection is open. */
  readonly live: boolean
}

/**
 * Subscribes to a thread's item stream from sequence zero: recorded events
 * replay first, then live events arrive. The stream aborts on thread change
 * or unmount.
 */
export function useThreadStream(
  client: BeeAgentClient,
  threadId: string | null,
): ThreadStreamState {
  const [state, setState] = useState<ThreadStreamState>({
    events: [],
    live: false,
  })

  useEffect(() => {
    if (!threadId) {
      setState({ events: [], live: false })
      return
    }
    const controller = new AbortController()
    setState({ events: [], live: true })
    void (async () => {
      try {
        for await (const event of client.streamItems(threadId, {
          signal: controller.signal,
        })) {
          setState((previous) => ({
            events: [...previous.events, event],
            live: true,
          }))
        }
        setState((previous) => ({ ...previous, live: false }))
      } catch (error) {
        console.error(`item stream for thread '${threadId}' failed`, error)
        setState((previous) => ({ ...previous, live: false }))
      }
    })()
    return () => controller.abort()
  }, [client, threadId])

  return state
}
