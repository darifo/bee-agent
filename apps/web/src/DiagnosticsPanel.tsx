import { useCallback, useEffect, useState } from 'react'
import type { BeeAgentClient, Diagnostics } from '@bee-agent/client'

export interface DiagnosticsPanelProps {
  client: BeeAgentClient
}

const PROPOSAL_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  testing: '实验中',
  review: '待审',
  trial: '试用中',
  promoted: '已生效',
  rejected: '已拒绝',
  'rolled-back': '已回滚',
}

/**
 * The host's one-call health overview, visualized (architecture §16.4
 * doctor): structure, memory, world model, scheduler, learning, and
 * conversation storage on one page, with the raw JSON behind a fold.
 */
export function DiagnosticsPanel({ client }: DiagnosticsPanelProps) {
  const [data, setData] = useState<Diagnostics | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      setData(await client.diagnostics())
      setError(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [client])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 30_000)
    return () => clearInterval(timer)
  }, [refresh])

  return (
    <section className="panel diagnostics" aria-label="diagnostics">
      <header>
        <h2>诊断</h2>
        <span className="trajectory-sub">
          主机健康一页总览，每 30 秒自动刷新
        </span>
        <button type="button" onClick={() => void refresh()} disabled={busy}>
          刷新
        </button>
      </header>
      {error !== undefined ? (
        <p className="console-error" role="alert">
          {error}
        </p>
      ) : data === undefined ? (
        <p className="empty">加载中…</p>
      ) : (
        <div className="diag-grid">
          <article
            className={`diag-card ${data.status === 'ok' ? 'diag-ok' : 'diag-warn'}`}
          >
            <h3>
              <span className="status-dot status-ok" aria-hidden="true" /> 主机
            </h3>
            <p className="diag-value">
              {data.status === 'ok' ? '运行正常' : '降级中'}
            </p>
            <p className="diag-meta">
              会话存储 {data.threads.streams} 条事件流
            </p>
          </article>

          <article
            className={`diag-card ${data.structure.restartRequired ? 'diag-warn' : 'diag-ok'}`}
          >
            <h3>🧬 结构</h3>
            <p className="diag-value">
              {data.structure.activeVersion === null
                ? '无激活结构'
                : `${data.structure.activeVersion.slice(0, 16)}…`}
            </p>
            {data.structure.restartRequired ? (
              <p className="diag-meta diag-alert">
                需要重启（{data.structure.restartRequiredPlugins.join('、')}）
              </p>
            ) : (
              <p className="diag-meta">结构稳定，无需重启</p>
            )}
          </article>

          <article
            className={`diag-card ${data.memory.enabled && data.memory.health.status === 'healthy' ? 'diag-ok' : data.memory.enabled ? 'diag-warn' : ''}`}
          >
            <h3>🧠 记忆</h3>
            {data.memory.enabled ? (
              <>
                <p className="diag-value">
                  {data.memory.health.status === 'healthy'
                    ? '健康'
                    : data.memory.health.status === 'degraded'
                      ? '降级'
                      : '不可用'}
                </p>
                <p className="diag-meta">
                  声明 {data.memory.claims.total} · 生效{' '}
                  {data.memory.claims.active} · 遗忘{' '}
                  {data.memory.claims.retracted}
                </p>
                {data.memory.health.detail !== undefined ? (
                  <p className="diag-meta">{data.memory.health.detail}</p>
                ) : null}
              </>
            ) : (
              <p className="diag-value">未启用</p>
            )}
          </article>

          <article className="diag-card diag-ok">
            <h3>🌍 世界模型</h3>
            {data.world.enabled ? (
              <>
                <p className="diag-value">v{data.world.version}</p>
                <p className="diag-meta">
                  实体 {data.world.entities} · 关系 {data.world.relations}
                </p>
              </>
            ) : (
              <p className="diag-value">未启用</p>
            )}
          </article>

          <article className="diag-card diag-ok">
            <h3>⏰ 调度器</h3>
            {data.scheduler.enabled ? (
              <>
                <p className="diag-value">运行中</p>
                <p className="diag-meta">触发器 {data.scheduler.triggers} 个</p>
              </>
            ) : (
              <p className="diag-value">未启用</p>
            )}
          </article>

          <article className="diag-card diag-ok">
            <h3>🌱 学习</h3>
            {data.learning.enabled ? (
              <>
                <p className="diag-value">慢循环运行中</p>
                <div className="diag-chips">
                  {Object.entries(data.learning.byStatus).map(
                    ([status, count]) => (
                      <span key={status} className="chip">
                        {PROPOSAL_STATUS_LABELS[status] ?? status}
                        <em>{count}</em>
                      </span>
                    ),
                  )}
                </div>
              </>
            ) : (
              <p className="diag-value">未启用</p>
            )}
          </article>
        </div>
      )}
      {data !== undefined ? (
        <details className="entry-payload">
          <summary>原始诊断数据</summary>
          <pre>{JSON.stringify(data, null, 2)}</pre>
        </details>
      ) : null}
    </section>
  )
}
