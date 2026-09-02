import type { ThreadEvent } from '@bee-agent/thread/protocol'

/** A rendered conversation entry, reduced from the thread's wire events. */
export type ChatEntry =
  | { readonly kind: 'user'; readonly content: string; readonly at?: string }
  | {
      readonly kind: 'assistant'
      readonly content: string
      readonly at?: string
      /** Still streaming: deltas are arriving for this message. */
      readonly streaming?: boolean
    }
  | {
      readonly kind: 'tool'
      readonly toolId: string
      /** Turn scope for the trajectory deep-link. */
      readonly turnId?: string
      /** One-line human summary of the result (never raw JSON). */
      readonly preview?: string
      /** Full tool result text, shown in the collapsible detail. */
      readonly result?: string
      readonly isError?: boolean
    }
  | {
      readonly kind: 'approval'
      readonly title: string
      readonly status: string
    }

/**
 * Reduces a thread's wire events into conversation entries. Assistant text
 * is accumulated from `item.delta` frames and finalized when the assistant
 * item completes; user messages, tool calls, and approvals map directly.
 */
export function deriveEntries(
  events: readonly ThreadEvent[],
): readonly ChatEntry[] {
  const entries: ChatEntry[] = []
  let assistant = ''
  let assistantOpen = false

  const flushAssistant = (): void => {
    if (assistantOpen && assistant.length > 0) {
      entries.push({ kind: 'assistant', content: assistant })
    }
    assistant = ''
    assistantOpen = false
  }

  const atOf = (item: { createdAt?: string }): string | undefined =>
    item.createdAt
  for (const event of events) {
    switch (event.event) {
      case 'item.started':
        if (
          event.item.type === 'message' &&
          event.item.payload.role === 'assistant'
        ) {
          flushAssistant()
          assistantOpen = true
        }
        break
      case 'item.delta':
        assistant += event.delta
        break
      case 'item.completed': {
        const item = event.item
        if (item.type === 'message') {
          if (item.payload.role === 'user') {
            flushAssistant()
            const at = atOf(item)
            entries.push({
              kind: 'user',
              content: item.payload.content,
              ...(at === undefined ? {} : { at }),
            })
          } else if (item.payload.role === 'assistant') {
            assistantOpen = false
            assistant = ''
            if (item.payload.content.trim() !== '') {
              const at = atOf(item)
              entries.push({
                kind: 'assistant',
                content: item.payload.content,
                ...(at === undefined ? {} : { at }),
              })
            }
          }
        } else if (item.type === 'tool_call') {
          const output = item.payload.output
          const content =
            item.payload.content ??
            (typeof output === 'string'
              ? output
              : output === undefined
                ? ''
                : JSON.stringify(output))
          if (content !== '') {
            const preview = summarizeToolResult(content)
            entries.push({
              kind: 'tool',
              toolId: item.payload.toolId,
              turnId: event.turnId,
              ...(preview === undefined ? {} : { preview }),
              result:
                content.length > 4000 ? `${content.slice(0, 4000)}…` : content,
              ...(item.payload.isError === undefined
                ? {}
                : { isError: item.payload.isError }),
            })
          }
        } else if (item.type === 'approval') {
          entries.push({
            kind: 'approval',
            title: item.payload.title,
            status: item.payload.status,
          })
        }
        break
      }
      default:
        break
    }
  }
  // An in-flight assistant message renders live — the deltas accumulate
  // into a streaming entry until its completion replaces it. (The old
  // final flush would have emitted it as a completed message instead.)
  if (assistantOpen && assistant.length > 0) {
    entries.push({ kind: 'assistant', content: assistant, streaming: true })
  }
  return entries
}

/**
 * One human-readable line for a tool result. JSON bodies collapse to their
 * most informative field (title/url/status…), text bodies to their first
 * non-empty line — raw JSON never leaks into the transcript.
 */
function summarizeToolResult(content: string): string | undefined {
  const trimmed = content.trim()
  if (trimmed === '') return undefined
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const pick = (value: unknown): string | undefined => {
        if (typeof value === 'string') return value
        if (Array.isArray(value)) {
          for (const item of value) {
            const found = pick(item)
            if (found !== undefined && found !== '') return found
          }
          return undefined
        }
        if (value !== null && typeof value === 'object') {
          const record = value as Record<string, unknown>
          for (const key of [
            'title',
            'url',
            'status',
            'statement',
            'hypothesis',
            'query',
            'id',
          ]) {
            const found = pick(record[key])
            if (found !== undefined) return found
          }
          for (const value2 of Object.values(record)) {
            const found = pick(value2)
            if (found !== undefined) return found
          }
        }
        return undefined
      }
      const found = pick(parsed)
      if (found !== undefined) return found.slice(0, 110)
    } catch {
      // fall through to first-line
    }
  }
  const firstLine = trimmed
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '')
  return firstLine === undefined ? undefined : firstLine.slice(0, 110)
}
