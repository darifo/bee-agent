import { useEffect, useRef } from 'react'
import type { AgentEvent } from '@bee-agent/contracts'
import { describeEvent } from '../format.js'

export interface EventFeedProps {
  events: readonly AgentEvent[]
  live: boolean
}

/** Chronological feed of a task's event stream. */
export function EventFeed({ events, live }: EventFeedProps) {
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // jsdom does not implement scrollIntoView; the optional call keeps the
    // component testable outside a real layout engine.
    bottom.current?.scrollIntoView?.({ block: 'nearest' })
  }, [events.length])

  return (
    <div className="event-feed">
      <div className="event-feed-head">
        events ({events.length}) {live ? '· live' : '· closed'}
      </div>
      <ol className="event-feed-list">
        {events.map((event) => (
          <li key={event.sequence} className={`event event-${event.type}`}>
            <span className="event-sequence">{event.sequence}</span>
            <span className="event-type">{event.type}</span>
            <span className="event-text">{describeEvent(event)}</span>
          </li>
        ))}
        <div ref={bottom} />
      </ol>
    </div>
  )
}
