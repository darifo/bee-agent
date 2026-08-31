import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BeeAgentClient, Diagnostics, TurnResult } from '@bee-agent/client'
import { useThreadStream } from './hooks/useThreadStream.ts'
import { deriveEntries } from './messages.ts'
import { KanbanBoard } from './KanbanBoard.tsx'
import { MemoryPanel } from './MemoryPanel.tsx'
import { LearningPanel } from './LearningPanel.tsx'

export interface AppProps {
  client: BeeAgentClient
}

interface PendingApproval {
  readonly turnId: string
  readonly approvalId: string
  readonly title: string
}

type View = 'chat' | 'board' | 'memory' | 'learning'

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
  const [view, setView] = useState<View>('chat')
  const [threadId, setThreadId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [pending, setPending] = useState<PendingApproval | undefined>()

  const [health, setHealth] = useState<Diagnostics | undefined>()
  const transcriptRef = useRef<HTMLElement | null>(null)

  const { events, live } = useThreadStream(client, threadId)
  const entries = useMemo(() => deriveEntries(events), [events])

  // Poll the one-call health overview for the header status dot.
  useEffect(() => {
    let cancelled = false
    const probe = async () => {
      try {
        const d = await client.diagnostics()
        if (!cancelled) setHealth(d)
      } catch {
        if (!cancelled) setHealth(undefined)
      }
    }
    void probe()
    const timer = setInterval(probe, 30_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [client])

  // Keep the newest message in view while Bee streams (jsdom has no
  // scrollTo — the optional call keeps tests honest).
  useEffect(() => {
    transcriptRef.current?.scrollTo?.({
      top: transcriptRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [entries.length, busy])

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
        <div className="brand">
          <h1>🐝 Bee</h1>
          <span className="brand-sub">个人智能体控制台</span>
        </div>
        <nav className="view-toggle">
          <button
            type="button"
            className={view === 'chat' ? 'active' : ''}
            onClick={() => setView('chat')}
          >
            对话
          </button>
          <button
            type="button"
            className={view === 'board' ? 'active' : ''}
            onClick={() => setView('board')}
          >
            看板
          </button>
          <button
            type="button"
            className={view === 'memory' ? 'active' : ''}
            onClick={() => setView('memory')}
          >
            记忆
          </button>
          <button
            type="button"
            className={view === 'learning' ? 'active' : ''}
            onClick={() => setView('learning')}
          >
            学习
          </button>
        </nav>
        <span
          className={`status-dot ${health === undefined ? 'status-down' : health.status === 'ok' ? 'status-ok' : 'status-warn'}`}
          title={
            health === undefined
              ? '无法连接主机'
              : health.status === 'ok'
                ? '主机运行正常'
                : '主机降级中（见 doctor）'
          }
          aria-label="host status"
        />
        {view === 'chat' ? (
          threadId === null ? (
            <button type="button" onClick={() => void start()} disabled={busy}>
              新建对话
            </button>
          ) : (
            <button type="button" onClick={() => setThreadId(null)}>
              重置
            </button>
          )
        ) : null}
      </header>
      {view === 'board' ? (
        <KanbanBoard client={client} />
      ) : view === 'memory' ? (
        <MemoryPanel client={client} />
      ) : view === 'learning' ? (
        <LearningPanel client={client} />
      ) : (
        <>
          {error !== undefined ? (
            <p className="console-error">{error}</p>
          ) : null}
          {threadId === null ? (
            <section className="welcome">
              <div className="welcome-bee" aria-hidden="true">
                🐝
              </div>
              <h2>开始一段对话</h2>
              <p>Bee 记得你的偏好、能安全地执行命令、会在看板上管理任务。</p>
              <ul className="welcome-hints">
                <li>「从现在起用中文写周报」— 它会记住这个偏好</li>
                <li>「用 command_run 列出 /tmp」— 会先征求你的审批</li>
                <li>「建个看板任务：整理文档」— 交给后台慢慢做</li>
              </ul>
            </section>
          ) : (
            <>
              <section
                className="transcript"
                aria-label="对话记录"
                ref={transcriptRef}
              >
                {entries.map((entry, index) => (
                  <Entry key={`${index}-${entry.kind}`} entry={entry} />
                ))}
                {busy ? (
                  <div className="typing" aria-label="Bee 正在输入">
                    <span className="dot" />
                    <span className="dot" />
                    <span className="dot" />
                    <em>Bee 正在思考…</em>
                  </div>
                ) : null}
              </section>
              {live ? (
                <p className="stream-live" aria-hidden="true">
                  ● 实时连接
                </p>
              ) : null}
              {pending !== undefined ? (
                <div className="approval" role="alert">
                  <span>需要审批：{pending.title}</span>
                  <button
                    type="button"
                    onClick={() => void decide('approved')}
                    disabled={busy}
                  >
                    批准
                  </button>
                  <button
                    type="button"
                    onClick={() => void decide('rejected')}
                    disabled={busy}
                  >
                    拒绝
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
                  placeholder="给 Bee 发消息…"
                  disabled={busy}
                  aria-label="消息输入框"
                />
                <button type="submit" disabled={busy || input.trim() === ''}>
                  发送
                </button>
              </form>
            </>
          )}
        </>
      )}
    </main>
  )
}

function approvalLabel(status: string): string {
  if (status === 'approved') return '已批准'
  if (status === 'rejected') return '已拒绝'
  return '待审批'
}

function Entry({ entry }: { entry: ReturnType<typeof deriveEntries>[number] }) {
  switch (entry.kind) {
    case 'user':
      return (
        <p className="msg msg-user">
          <strong>我</strong> {entry.content}
        </p>
      )
    case 'assistant':
      return (
        <p className="msg msg-assistant">
          <strong>Bee</strong> {entry.content}
        </p>
      )
    case 'tool':
      return (
        <p className="msg msg-tool">
          <em>调用工具 {entry.toolId}</em>
        </p>
      )
    case 'approval':
      return (
        <p className="msg msg-approval">
          <em>
            审批「{entry.title}」（{approvalLabel(entry.status)}）
          </em>
        </p>
      )
  }
}
