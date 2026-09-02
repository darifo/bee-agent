import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  BeeAgentClient,
  Diagnostics,
  ModelReplayDto,
  TurnResult,
  TurnTrajectoryDto,
} from '@bee-agent/client'
import { useThreadStream } from './hooks/useThreadStream.ts'
import { deriveEntries } from './messages.ts'
import { KanbanBoard } from './KanbanBoard.tsx'
import { MemoryPanel } from './MemoryPanel.tsx'
import { LearningPanel } from './LearningPanel.tsx'
import { TrajectoryPanel } from './TrajectoryPanel.tsx'
import { ThreadHistory } from './ThreadHistory.tsx'
import { DiagnosticsPanel } from './DiagnosticsPanel.tsx'

export interface AppProps {
  client: BeeAgentClient
}

interface PendingApproval {
  readonly turnId: string
  readonly approvalId: string
  readonly title: string
}

type View =
  'chat' | 'board' | 'memory' | 'learning' | 'trajectory' | 'diagnostics'

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
  const [trajectoryLink, setTrajectoryLink] = useState<
    { threadId: string; turnId: string } | undefined
  >()

  const [health, setHealth] = useState<Diagnostics | undefined>()
  const [threadsKey, setThreadsKey] = useState(0)
  const transcriptRef = useRef<HTMLElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)

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
  const lastEntry = entries[entries.length - 1]
  const lastContentLength =
    lastEntry !== undefined &&
    (lastEntry.kind === 'user' || lastEntry.kind === 'assistant')
      ? lastEntry.content.length
      : 0
  useEffect(() => {
    transcriptRef.current?.scrollTo?.({
      top: transcriptRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [entries.length, lastContentLength, busy])

  const start = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    try {
      const thread = await client.createThread({ title: 'Web conversation' })
      setThreadId(thread.id)
      setThreadsKey((key) => key + 1)
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
      setThreadsKey((key) => key + 1)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
      setInput('')
      if (composerRef.current !== null) {
        composerRef.current.style.height = 'auto'
      }
    }
  }, [client, threadId, input])

  const exportMarkdown = useCallback(() => {
    const now = new Date()
    const pad = (value: number): string => String(value).padStart(2, '0')
    const lines: string[] = [
      `# Bee 对话 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      '',
    ]
    for (const entry of entries) {
      if (entry.kind === 'user') {
        lines.push('## 我', '', entry.content, '')
      } else if (entry.kind === 'assistant') {
        lines.push('## Bee', '', entry.content, '')
      } else if (entry.kind === 'tool') {
        lines.push(
          `> 🧩 调用工具 ${entry.toolId}${entry.preview !== undefined ? ` — ${entry.preview}` : ''}`,
          '',
        )
      }
    }
    const blob = new Blob([lines.join('\n')], {
      type: 'text/markdown;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `bee-对话-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.md`
    anchor.click()
    URL.revokeObjectURL(url)
  }, [entries])

  const stop = useCallback(async () => {
    if (threadId === null) return
    try {
      await client.cancelTurns(threadId)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [client, threadId])

  const decide = useCallback(
    async (
      decision: 'approved' | 'rejected',
      options: { persist?: boolean } = {},
    ) => {
      if (threadId === null || pending === undefined) return
      setBusy(true)
      setError(undefined)
      try {
        await client.resolveApproval(
          threadId,
          pending.turnId,
          pending.approvalId,
          decision,
          options,
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
          <button
            type="button"
            className={view === 'trajectory' ? 'active' : ''}
            onClick={() => setView('trajectory')}
          >
            轨迹
          </button>
          <button
            type="button"
            className={view === 'diagnostics' ? 'active' : ''}
            onClick={() => setView('diagnostics')}
          >
            诊断
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
      </header>
      {view === 'board' ? (
        <KanbanBoard client={client} />
      ) : view === 'memory' ? (
        <MemoryPanel client={client} />
      ) : view === 'learning' ? (
        <LearningPanel client={client} />
      ) : view === 'trajectory' ? (
        <TrajectoryPanel client={client} />
      ) : view === 'diagnostics' ? (
        <DiagnosticsPanel client={client} />
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
                {[
                  {
                    hint: '「从现在起用中文写周报」— 它会记住这个偏好',
                    fill: '从现在起用中文写周报',
                  },
                  {
                    hint: '「用 web_fetch 看看 BBC 头条」— 立刻试试网络研究',
                    fill: '用 web_fetch 抓取 BBC 世界新闻头条，总结 3 条并附原文链接',
                  },
                  {
                    hint: '「建个看板任务：整理文档」— 交给后台慢慢做',
                    fill: '建一个看板任务：整理文档并归档',
                  },
                ].map((item) => (
                  <li key={item.fill}>
                    <button
                      type="button"
                      onClick={() => {
                        setInput(item.fill)
                        if (threadId === null) void start()
                      }}
                    >
                      {item.hint}
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="cta"
                onClick={() => void start()}
                disabled={busy}
              >
                ✏️ 新建对话
              </button>
            </section>
          ) : (
            <>
              <section
                className="transcript"
                aria-label="对话记录"
                ref={transcriptRef}
              >
                {entries.map((entry, index) => (
                  <Entry
                    key={`${index}-${entry.kind}`}
                    entry={entry}
                    threadId={threadId}
                    onOpenTrajectory={setTrajectoryLink}
                  />
                ))}
                {busy &&
                !entries.some(
                  (entry) => entry.kind === 'assistant' && entry.streaming,
                ) ? (
                  <div className="typing" aria-label="Bee 正在输入">
                    <span className="dot" />
                    <span className="dot" />
                    <span className="dot" />
                    <em>Bee 正在思考…</em>
                  </div>
                ) : null}
              </section>
              <div className="thread-meta">
                {live ? (
                  <span className="stream-live" aria-hidden="true">
                    ● 实时连接
                  </span>
                ) : null}
                <button
                  type="button"
                  className="ghost"
                  onClick={exportMarkdown}
                  title="导出本次对话为 Markdown"
                >
                  ⬇ 导出
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setThreadId(null)}
                >
                  结束对话
                </button>
              </div>
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
                    onClick={() => void decide('approved', { persist: true })}
                    disabled={busy}
                    title="记住此授权：同类操作不再逐次询问，可随时在诊断页撤销"
                  >
                    批准并记住
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
                <textarea
                  ref={composerRef}
                  value={input}
                  rows={1}
                  onChange={(event) => {
                    setInput(event.target.value)
                    autosize(event.target)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      if (input.trim() !== '' && !busy) void send()
                    }
                  }}
                  placeholder="给 Bee 发消息…（Enter 发送，Shift+Enter 换行）"
                  disabled={busy}
                  aria-label="消息输入框"
                />
                <button type="submit" disabled={busy || input.trim() === ''}>
                  发送
                </button>
                {busy ? (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void stop()}
                    title="停止当前回合"
                  >
                    ⏹ 停止
                  </button>
                ) : null}
              </form>
            </>
          )}
          <ThreadHistory
            client={client}
            activeThreadId={threadId}
            busy={busy}
            refreshKey={threadsKey}
            onOpen={setThreadId}
            onNew={() => void start()}
          />
          <TrajectoryDrawer
            client={client}
            link={trajectoryLink}
            onClose={() => setTrajectoryLink(undefined)}
          />
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

function entryTime(at: string | undefined): string {
  if (at === undefined) return ''
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const TOOL_LABELS: Record<string, { icon: string; name: string }> = {
  web_fetch: { icon: '🌐', name: '抓取网页' },
  web_search: { icon: '🔎', name: '网络检索' },
  command_run: { icon: '⌨️', name: '执行命令' },
  python_run: { icon: '🐍', name: '运行 Python' },
  time_now: { icon: '🕒', name: '查询时间' },
  kanban_create: { icon: '📋', name: '新建看板任务' },
  kanban_list: { icon: '📋', name: '查看看板' },
  kanban_show: { icon: '📋', name: '查看任务' },
  kanban_update: { icon: '📋', name: '更新任务' },
  kanban_block: { icon: '📋', name: '阻塞任务' },
  kanban_comment: { icon: '📋', name: '任务评论' },
  kanban_complete: { icon: '📋', name: '完成任务' },
  kanban_cancel: { icon: '📋', name: '取消任务' },
}

function toolLabel(toolId: string): { icon: string; name: string } {
  return TOOL_LABELS[toolId] ?? { icon: '🧩', name: toolId }
}

/** Grows the composer with its content, capped at six lines. */
function autosize(el: HTMLTextAreaElement): void {
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 144)}px`
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="msg-copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      aria-label="复制回复"
      title="复制 Markdown 原文"
    >
      {copied ? '✓ 已复制' : '⧉ 复制'}
    </button>
  )
}

function MessageHead({
  who,
  at,
  tone,
  action,
}: {
  who: string
  at: string | undefined
  tone: 'user' | 'bee'
  action?: React.ReactNode
}) {
  return (
    <div className="msg-head">
      <span className={`msg-avatar msg-avatar-${tone}`}>{who}</span>
      {action}
      {at !== undefined ? (
        <time className="msg-time">{entryTime(at)}</time>
      ) : null}
    </div>
  )
}

function Entry({
  entry,
  threadId,
  onOpenTrajectory,
}: {
  entry: ReturnType<typeof deriveEntries>[number]
  threadId: string | null
  onOpenTrajectory: (link: { threadId: string; turnId: string }) => void
}) {
  switch (entry.kind) {
    case 'user':
      return (
        <div className="msg msg-user">
          <MessageHead who="我" at={entry.at} tone="user" />
          <div className="msg-body">{entry.content}</div>
        </div>
      )
    case 'assistant':
      return (
        <div
          className={
            entry.streaming === true
              ? 'msg msg-assistant msg-streaming'
              : 'msg msg-assistant'
          }
        >
          <MessageHead
            who="🐝"
            at={entry.at}
            tone="bee"
            action={<CopyButton text={entry.content} />}
          />
          <div className="msg-md">
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: (props) => (
                  <a {...props} target="_blank" rel="noreferrer noopener" />
                ),
              }}
            >
              {entry.content}
            </Markdown>
            {entry.streaming === true ? (
              <span className="stream-cursor" aria-hidden="true" />
            ) : null}
          </div>
        </div>
      )
    case 'tool':
      return (
        <ToolCard
          entry={entry}
          threadId={threadId}
          onOpenTrajectory={onOpenTrajectory}
        />
      )
    case 'approval':
      return (
        <div className="msg msg-approval">
          <span className="approval-icon">
            {entry.status === 'approved'
              ? '✅'
              : entry.status === 'rejected'
                ? '🚫'
                : '⏳'}
          </span>
          审批「{entry.title}」
          <span className={`badge badge-${entry.status}`}>
            {approvalLabel(entry.status)}
          </span>
        </div>
      )
  }
}

function ToolCard({
  entry,
  threadId,
  onOpenTrajectory,
}: {
  entry: Extract<ReturnType<typeof deriveEntries>[number], { kind: 'tool' }>
  threadId: string | null
  onOpenTrajectory: (link: { threadId: string; turnId: string }) => void
}) {
  const { icon, name } = toolLabel(entry.toolId)
  return (
    <details className="msg msg-tool tool-card">
      <summary>
        <span className="tool-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="tool-name">{name}</span>
        {entry.preview !== undefined ? (
          <span className="tool-preview">{entry.preview}</span>
        ) : null}
        {entry.isError === true ? (
          <span className="tool-error">失败</span>
        ) : null}
        {entry.turnId !== undefined && threadId !== null ? (
          <button
            type="button"
            className="tool-trace"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onOpenTrajectory({
                threadId,
                turnId: entry.turnId as string,
              })
            }}
            title="查看本轮因果轨迹"
          >
            轨迹
          </button>
        ) : null}
        <span className="tool-chevron" aria-hidden="true">
          ▾
        </span>
      </summary>
      {entry.result !== undefined ? (
        <pre className="tool-result">{entry.result}</pre>
      ) : null}
    </details>
  )
}

const TRAJECTORY_OUTCOME_LABELS: Record<string, string> = {
  completed: '完成',
  failed: '失败',
  denied: '被拒',
  started: '进行中',
  unknown: '未知',
}

/**
 * The per-turn causal view (architecture §7.4, WF4-E): generations with
 * usage and latency, tool actions with their authorization decisions, and
 * checkpoints — the deep link from any tool card in the transcript.
 */
const REPLAY_SECTION_LABELS: Record<string, string> = {
  instruction: '系统指令',
  goal: '目标',
  world: '世界模型',
  trajectory: '历史轨迹',
  memory: '记忆召回',
  skill: '技能',
  tool: '工具声明',
}

function TrajectoryDrawer({
  client,
  link,
  onClose,
}: {
  client: BeeAgentClient
  link: { threadId: string; turnId: string } | undefined
  onClose: () => void
}) {
  const [data, setData] = useState<TurnTrajectoryDto | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [replay, setReplay] = useState<
    | { requestId: string; state: ModelReplayDto | 'loading' | string }
    | undefined
  >()

  useEffect(() => {
    if (link === undefined) {
      setData(undefined)
      return
    }
    setData(undefined)
    setError(undefined)
    void client
      .getTurnTrajectory(link.threadId, link.turnId)
      .then(setData)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
  }, [client, link])

  if (link === undefined) return null
  return (
    <div className="drawer-backdrop" role="presentation" onClick={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-label="轮次轨迹"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="drawer-head">
          <h3>轮次轨迹</h3>
          <button type="button" className="ghost" onClick={onClose}>
            ✕ 关闭
          </button>
        </header>
        {error !== undefined ? (
          <p className="console-error" role="alert">
            {error}
          </p>
        ) : data === undefined ? (
          <p className="drawer-loading">加载中…</p>
        ) : (
          <div className="drawer-body">
            <p className="drawer-meta">
              状态 {data.status ?? '—'} · 触发 {data.trigger ?? '—'} · 模型调用{' '}
              {data.generations.length} 次 · 工具 {data.tools.length} 个 ·
              检查点 {data.checkpoints.length} 个
            </p>
            {data.input !== undefined ? (
              <p className="drawer-input">「{data.input}」</p>
            ) : null}
            <section>
              <h4>模型调用</h4>
              {data.generations.length === 0 ? (
                <p className="empty">无</p>
              ) : (
                <ul className="trace-list">
                  {data.generations.map((generation, index) => (
                    <li key={index} className="trace-item">
                      <span className="trace-step">
                        步 {generation.stepIndex}
                      </span>
                      <span className="trace-main">
                        {generation.model} ·{' '}
                        {generation.error !== undefined
                          ? `失败：${generation.error}`
                          : generation.stopReason}
                      </span>
                      {generation.usage !== undefined ? (
                        <span className="trace-meta">
                          {generation.usage.totalTokens} tokens ·{' '}
                          {generation.latencyMs ?? 0}ms
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="tool-trace"
                        onClick={() => {
                          setReplay({
                            requestId: generation.requestId,
                            state: 'loading',
                          })
                          void client
                            .replayModelRequest(generation.requestId)
                            .then((dto) =>
                              setReplay({
                                requestId: generation.requestId,
                                state: dto,
                              }),
                            )
                            .catch((reason: unknown) =>
                              setReplay({
                                requestId: generation.requestId,
                                state:
                                  reason instanceof Error
                                    ? reason.message
                                    : String(reason),
                              }),
                            )
                        }}
                        title="重放该次模型实际看到的上下文"
                      >
                        重放
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h4>工具动作</h4>
              {data.tools.length === 0 ? (
                <p className="empty">无</p>
              ) : (
                <ul className="trace-list">
                  {data.tools.map((tool) => (
                    <li key={tool.callId}>
                      <span className="trace-step">{tool.toolId}</span>
                      <span className="trace-main">
                        {TRAJECTORY_OUTCOME_LABELS[tool.outcome] ??
                          tool.outcome}
                        {tool.decision !== undefined
                          ? ` · 授权 ${tool.decision}`
                          : ''}
                      </span>
                      {tool.decisionReason !== undefined ? (
                        <span className="trace-meta">
                          {tool.decisionReason}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {replay !== undefined ? (
              <section className="replay-panel">
                <h4>
                  模型输入重放
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setReplay(undefined)}
                  >
                    ✕
                  </button>
                </h4>
                {replay.state === 'loading' ? (
                  <p className="drawer-loading">重放中…</p>
                ) : typeof replay.state === 'string' ? (
                  <p className="console-error">{replay.state}</p>
                ) : (
                  <>
                    <p className="drawer-meta">
                      摘要已验证 ✓ · 预算 {replay.state.manifest.tokenBudget}{' '}
                      tokens · 消息 {replay.state.bundle.messages.length} 条
                    </p>
                    <ul className="replay-sections">
                      {replay.state.manifest.sections.map((section, i) => (
                        <li
                          key={i}
                          className={
                            section.kind === 'memory' ? 'replay-memory' : ''
                          }
                        >
                          {REPLAY_SECTION_LABELS[section.kind] ?? section.kind}
                          <em>{section.tokens} tokens</em>
                        </li>
                      ))}
                    </ul>
                    <ul className="replay-messages">
                      {replay.state.bundle.messages.map((message, i) => (
                        <li key={i}>
                          <strong>{message.role}</strong>
                          <span>{message.content.slice(0, 200)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
            ) : null}
            <section>
              <h4>检查点</h4>
              {data.checkpoints.length === 0 ? (
                <p className="empty">无</p>
              ) : (
                <ul className="trace-list">
                  {data.checkpoints.map((checkpoint) => (
                    <li key={checkpoint.sequence}>
                      <span className="trace-step">
                        步 {checkpoint.stepIndex}
                      </span>
                      <span className="trace-main">
                        {checkpoint.stateDigest.slice(0, 20)}…
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </aside>
    </div>
  )
}
