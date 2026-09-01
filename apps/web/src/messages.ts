import type { ThreadEvent } from '@bee-agent/thread/protocol'

/** A rendered conversation entry, reduced from the thread's wire events. */
export type ChatEntry =
  | { readonly kind: 'user'; readonly content: string; readonly at?: string }
  | {
      readonly kind: 'assistant'
      readonly content: string
      readonly at?: string
    }
  | {
      readonly kind: 'tool'
      readonly toolId: string
      /** First line of the tool result — for web_fetch this is the source link. */
      readonly preview?: string
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
            const at = atOf(item)
            entries.push({
              kind: 'assistant',
              content: item.payload.content,
              ...(at === undefined ? {} : { at }),
            })
            assistant = ''
          }
        } else if (item.type === 'tool_call') {
          const firstLine = (item.payload.content ?? '')
            .split('\n')
            .map((line) => line.trim())
            .find((line) => line !== '')
          entries.push({
            kind: 'tool',
            toolId: item.payload.toolId,
            ...(firstLine === undefined || firstLine === ''
              ? {}
              : { preview: firstLine.slice(0, 110) }),
          })
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
  flushAssistant()
  return entries
}
