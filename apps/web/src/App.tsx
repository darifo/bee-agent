import { useCallback, useMemo, useState } from 'react'
import type { TurnResult } from '@bee-agent/client'
import type { BeeAgentClient } from '@bee-agent/client'
import { useThreadStream } from './hooks/useThreadStream.ts'
import { deriveEntries } from './messages.ts'

export interface AppProps {
  client: BeeAgentClient
}

interface PendingApproval {
  readonly turnId: string
  readonly approvalId: string
  readonly title: string
}

function outputOf(result: TurnResult): string {
  if (result.status === 'completed') return result.output
  if (result.status === 'failed') return `[failed] ${result.error}`
  if (result.status === 'cancelled') return '[cancelled]'
  return ''
}

/**
 * Conversation view: one thread whose item stream drives the transcript.
 * The user sends messages as turns; suspended turns surface an approval
 * prompt (architecture §9.1 Thread–Turn–Item, §16.4 local Web).
 */
export function App({ client }: AppProps) {
  const [threadId, setThreadId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [pending, setPending] = useState<PendingApproval | undefined>()

  const { events } = useThreadStream(client, threadId)
  const entries = useMemo(() => deriveEntries(events), [events])

  const start = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    try {
      const thread = await client.createThread({ title: 'Web conversation' })
      setThreadId(thread.id)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [client])

  const send = useCallback(async () => {
    if (threadId === null || input.trim() === '') return
    setBusy(true)
    setError(undefined)
    try {
      const result = await client.createTurn(threadId, { input })
      if (result.status === 'suspended') {
        setPending({
          turnId: result.turn.id,
          approvalId: result.approval.approvalId,
          title: result.approval.title,
        })
      } else {
        setPending(undefined)
      }
      void outputOf(result)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
      setInput('')
    }
  }, [client, threadId, input])

  const decide = useCallback(
    async (decision: 'approved' | 'rejected') => {
      if (threadId === null || pending === undefined) return
      setBusy(true)
      setError(undefined)
      try {
        await client.resolveApproval(
          threadId,
          pending.turnId,
          pending.approvalId,
          decision,
        )
        setPending(undefined)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(false)
      }
    },
    [client, threadId, pending],
  )

  return (
    <main className="console">
      <header className="console-head">
        <h1>Bee</h1>
        {threadId === null ? (
          <button type="button" onClick={() => void start()} disabled={busy}>
            New conversation
          </button>
        ) : (
          <button type="button" onClick={() => setThreadId(null)}>
            Reset
          </button>
        )}
      </header>
      {error !== undefined ? <p className="console-error">{error}</p> : null}
      {threadId === null ? (
        <section className="task-detail-empty">
          Start a conversation to talk to Bee.
        </section>
      ) : (
        <>
          <section className="transcript" aria-label="conversation">
            {entries.map((entry, index) => (
              <Entry key={`${index}-${entry.kind}`} entry={entry} />
            ))}
          </section>
          {pending !== undefined ? (
            <div className="approval" role="alert">
              <span>Approval needed: {pending.title}</span>
              <button
                type="button"
                onClick={() => void decide('approved')}
                disabled={busy}
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() => void decide('rejected')}
                disabled={busy}
              >
                Reject
              </button>
            </div>
          ) : null}
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault()
              void send()
            }}
          >
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Message Bee…"
              disabled={busy}
              aria-label="message"
            />
            <button type="submit" disabled={busy || input.trim() === ''}>
              Send
            </button>
          </form>
        </>
      )}
    </main>
  )
}

function Entry({ entry }: { entry: ReturnType<typeof deriveEntries>[number] }) {
  switch (entry.kind) {
    case 'user':
      return (
        <p className="msg msg-user">
          <strong>you</strong> {entry.content}
        </p>
      )
    case 'assistant':
      return (
        <p className="msg msg-assistant">
          <strong>bee</strong> {entry.content}
        </p>
      )
    case 'tool':
      return (
        <p className="msg msg-tool">
          <em>tool {entry.toolId}</em>
        </p>
      )
    case 'approval':
      return (
        <p className="msg msg-approval">
          <em>
            approval “{entry.title}” ({entry.status})
          </em>
        </p>
      )
  }
}
