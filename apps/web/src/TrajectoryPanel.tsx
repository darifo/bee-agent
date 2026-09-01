import { useCallback, useEffect, useState } from 'react'
import type {
  BeeAgentClient,
  ModelReplayDto,
  TrajectoryCategory,
  TrajectoryEntryDto,
  TrajectoryLoop,
  TrajectoryPageDto,
} from '@bee-agent/client'

export interface TrajectoryPanelProps {
  client: BeeAgentClient
}

/**
 * Trajectory view (architecture §7.4 observability): one timeline over every
 * Chronicle stream, split into the foreground fast loop (user-facing turns)
 * and the background slow loop (memory, learning, governance). Every entry
 * cites its durable position — stream, sequence, event id — and model calls
 * can replay their digest-verified context, so nothing that happened is
 * invisible.
 */

const CATEGORY_ORDER: readonly TrajectoryCategory[] = [
  'input',
  'llm',
  'tool',
  'memory',
  'reasoning',
  'proposal',
  'system',
]

const CATEGORY_LABELS: Record<TrajectoryCategory, string> = {
  input: '用户输入',
  llm: 'LLM 响应',
  tool: '工具调用',
  memory: '记忆',
  reasoning: '辩证推理',
  proposal: '进化提议',
  system: '系统运行',
}

const CATEGORY_ICONS: Record<TrajectoryCategory, string> = {
  input: '✏️',
  llm: '🤖',
  tool: '🛠️',
  memory: '🧠',
  reasoning: '🔁',
  proposal: '🌱',
  system: '⚙️',
}

const EVENT_LABELS: Record<string, string> = {
  'thread.created': '会话创建',
  'context.compacted': '上下文压缩',
  'turn.started': '轮开始',
  'turn.completed': '轮完成',
  'turn.failed': '轮失败',
  'turn.cancelled': '轮取消',
  'item.completed': '条目完成',
  'item.failed': '条目失败',
  'approval.requested': '请求审批',
  'approval.resolved': '审批决定',
  'agent.checkpoint': '检查点',
  'model.requested': '模型调用',
  'model.completed': '模型返回',
  'model.failed': '模型失败',
  'context.manifest': '上下文清单',
  'execution.requested': '动作请求',
  'execution.authorized': '授权',
  'execution.denied': '拒绝',
  'execution.approval_required': '等待审批',
  'execution.completed': '动作完成',
  'execution.failed': '动作失败',
  'learning.loop.run': '学习循环',
  'learning.proposal.created': '新提议',
  'learning.proposal.status_changed': '提议状态',
  'learning.experiment.started': '实验开始',
  'learning.experiment.completed': '实验完成',
  'learning.experiment.failed': '实验失败',
  'learning.proposal.activated': '提议生效',
  'learning.proposal.activation-reverted': '提议回滚',
  'learning.drift.checked': '漂移检查',
  'memory.claim.recorded': '记忆记录',
  'memory.claim.superseded': '记忆取代',
  'memory.claim.retracted': '记忆遗忘',
  'memory.observation.recorded': '观察记录',
  'memory.consolidation.completed': '记忆整合',
  'memory.health.changed': '记忆健康',
  'scheduler.trigger.registered': '注册触发器',
  'scheduler.trigger.triggered': '触发器运行',
  'scheduler.trigger.removed': '移除触发器',
  'structure.resolved': '结构解析',
  'structure.prepared': '结构准备',
  'structure.activated': '结构激活',
  'structure.updated': '结构更新',
  'structure.activation_failed': '结构激活失败',
  'world.entity.recorded': '世界实体',
  'world.relation.projected': '世界关系',
  'world.version.bumped': '世界版本',
}

const SECTION_KIND_LABELS: Record<string, string> = {
  instruction: '系统指令',
  goal: '目标',
  world: '世界模型',
  trajectory: '历史轨迹',
  memory: '记忆召回',
  skill: '技能',
  tool: '工具声明',
}

const ROLE_LABELS: Record<string, string> = {
  system: '系统',
  user: '用户',
  assistant: 'Bee',
  tool: '工具',
}

function eventLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? eventType
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

interface ReplayState {
  readonly status: 'loading' | 'ok' | 'error'
  readonly data?: ModelReplayDto | undefined
  readonly error?: string | undefined
}

export function TrajectoryPanel({ client }: TrajectoryPanelProps) {
  const [loop, setLoop] = useState<TrajectoryLoop>('fast')
  const [category, setCategory] = useState<TrajectoryCategory | undefined>()
  const [limit, setLimit] = useState(150)
  const [page, setPage] = useState<TrajectoryPageDto | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [expanded, setExpanded] = useState<string | undefined>()
  const [replays, setReplays] = useState<Record<string, ReplayState>>({})

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      setPage(
        await client.listTrajectory({
          loop,
          ...(category === undefined ? {} : { category }),
          limit,
        }),
      )
      setError(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [client, loop, category, limit])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggleExpanded = useCallback((eventId: string) => {
    setExpanded((current) => (current === eventId ? undefined : eventId))
  }, [])

  const loadReplay = useCallback(
    async (eventId: string, requestId: string) => {
      setReplays((current) => ({
        ...current,
        [eventId]: { status: 'loading' },
      }))
      try {
        const data = await client.replayModelRequest(requestId)
        setReplays((current) => ({
          ...current,
          [eventId]: { status: 'ok', data },
        }))
      } catch (reason) {
        setReplays((current) => ({
          ...current,
          [eventId]: {
            status: 'error',
            error: reason instanceof Error ? reason.message : String(reason),
          },
        }))
      }
    },
    [client],
  )

  const entries = page?.entries ?? []
  const counts = page?.counts.byCategory

  return (
    <section className="panel trajectory" aria-label="trajectory">
      <header>
        <h2>轨迹</h2>
        <span className="trajectory-sub">
          一切运行过程，可见可追溯（{page?.scannedStreams ?? '…'} 条事件流）
        </span>
        <button type="button" onClick={() => void refresh()} disabled={busy}>
          刷新
        </button>
      </header>

      <div className="loop-switch" role="tablist" aria-label="循环视图">
        <button
          type="button"
          role="tab"
          aria-selected={loop === 'fast'}
          className={loop === 'fast' ? 'active' : ''}
          onClick={() => {
            setLoop('fast')
            setCategory(undefined)
            setExpanded(undefined)
          }}
        >
          <strong>前台快循环</strong>
          <span>用户对话 · 模型推理 · 工具执行</span>
          <em>{page?.counts.fast ?? 0} 条</em>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={loop === 'slow'}
          className={loop === 'slow' ? 'active' : ''}
          onClick={() => {
            setLoop('slow')
            setCategory(undefined)
            setExpanded(undefined)
          }}
        >
          <strong>后台慢循环</strong>
          <span>记忆沉淀 · 辩证学习 · 进化治理</span>
          <em>{page?.counts.slow ?? 0} 条</em>
        </button>
      </div>

      <div className="chip-row" aria-label="事件类别过滤">
        <button
          type="button"
          className={`chip ${category === undefined ? 'chip-active' : ''}`}
          onClick={() => setCategory(undefined)}
        >
          全部
        </button>
        {CATEGORY_ORDER.map((cat) => (
          <button
            type="button"
            key={cat}
            className={`chip ${category === cat ? 'chip-active' : ''}`}
            onClick={() => setCategory(category === cat ? undefined : cat)}
          >
            {CATEGORY_ICONS[cat]} {CATEGORY_LABELS[cat]}
            {counts !== undefined ? <em>{counts[cat]}</em> : null}
          </button>
        ))}
      </div>

      {error !== undefined ? (
        <p className="console-error" role="alert">
          {error}
        </p>
      ) : null}

      {entries.length === 0 && !busy ? (
        <p className="empty">
          这个循环里还没有可展示的事件——去和 Bee 说句话，或运行一次学习循环。
        </p>
      ) : (
        <ul className="trajectory-list">
          {entries.map((entry) => (
            <TrajectoryRow
              key={entry.eventId}
              entry={entry}
              open={expanded === entry.eventId}
              replay={replays[entry.eventId]}
              onToggle={() => toggleExpanded(entry.eventId)}
              onLoadReplay={() => {
                const requestId = String(entry.detail?.requestId ?? '')
                if (requestId !== '') void loadReplay(entry.eventId, requestId)
              }}
            />
          ))}
        </ul>
      )}

      {busy ? <p className="trajectory-loading">加载中…</p> : null}
      {entries.length >= limit ? (
        <button
          type="button"
          className="ghost"
          onClick={() => setLimit((current) => Math.min(500, current + 150))}
          disabled={busy || limit >= 500}
        >
          加载更多
        </button>
      ) : null}
    </section>
  )
}

function TrajectoryRow({
  entry,
  open,
  replay,
  onToggle,
  onLoadReplay,
}: {
  entry: TrajectoryEntryDto
  open: boolean
  replay: ReplayState | undefined
  onToggle: () => void
  onLoadReplay: () => void
}) {
  return (
    <li className={`trajectory-entry cat-${entry.category}`}>
      <button
        type="button"
        className="entry-head"
        onClick={onToggle}
        aria-expanded={open}
      >
        <time className="entry-time">{formatTime(entry.eventTime)}</time>
        <span className="entry-cat">
          {CATEGORY_ICONS[entry.category]} {CATEGORY_LABELS[entry.category]}
        </span>
        <span className="entry-type">{eventLabel(entry.eventType)}</span>
        <span className="entry-summary">{entry.summary}</span>
      </button>
      {open ? (
        <div className="entry-detail">
          <p className="entry-pos">
            {entry.streamId} · #{entry.sequence} · {entry.eventId}
            {entry.turnId !== undefined ? ` · turn ${entry.turnId}` : ''}
          </p>
          {entry.eventType === 'model.requested' &&
          entry.detail?.requestId !== undefined ? (
            <ReplayBlock replay={replay} onLoad={onLoadReplay} />
          ) : null}
          <details className="entry-payload">
            <summary>原始事件载荷</summary>
            <pre>{JSON.stringify(entry.detail, null, 2)}</pre>
          </details>
        </div>
      ) : null}
    </li>
  )
}

function ReplayBlock({
  replay,
  onLoad,
}: {
  replay: ReplayState | undefined
  onLoad: () => void
}) {
  if (replay === undefined) {
    return (
      <button type="button" className="ghost" onClick={onLoad}>
        🔍 重放模型输入（含记忆召回）
      </button>
    )
  }
  if (replay.status === 'loading') {
    return <p className="entry-replay">重放中…</p>
  }
  if (replay.status === 'error') {
    return <p className="console-error">重放失败：{replay.error}</p>
  }
  const data = replay.data
  if (data === undefined) return null
  return (
    <div className="entry-replay">
      <p className="replay-title">
        模型实际看到的上下文（摘要已验证 ✓，预算 {data.manifest.tokenBudget}{' '}
        tokens）
      </p>
      <ul className="replay-sections">
        {data.manifest.sections.map((section, index) => (
          <li
            key={`${index}-${section.kind}`}
            className={section.kind === 'memory' ? 'replay-memory' : ''}
          >
            {SECTION_KIND_LABELS[section.kind] ?? section.kind}
            <em>{section.tokens} tokens</em>
          </li>
        ))}
      </ul>
      {data.manifest.omissions.length > 0 ? (
        <p className="replay-omissions">
          已省略：
          {data.manifest.omissions
            .map((omission) => `${omission.sourceId}（${omission.reason}）`)
            .join('、')}
        </p>
      ) : null}
      <ul className="replay-messages">
        {data.bundle.messages.map((message, index) => (
          <li key={index}>
            <strong>{ROLE_LABELS[message.role] ?? message.role}</strong>
            <span>{clip(message.content, 400)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
