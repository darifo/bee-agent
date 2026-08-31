import { useCallback, useEffect, useState } from 'react'
import type { BeeAgentClient, LearningProposalDto } from '@bee-agent/client'

export interface LearningPanelProps {
  client: BeeAgentClient
}

/**
 * Learning governance view (v1 refactor plan §5.7 WF6-B): the Phase 5 arc
 * operable from the browser — run the slow loop, inspect proposals, run the
 * isolated experiment, and drive the lifecycle (review → trial → promote →
 * rollback). The buttons mirror what the CLI exposes; every click lands on
 * a durable Chronicle fact.
 */
const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  testing: '实验中',
  review: '待审',
  trial: '试用中',
  promoted: '已生效',
  rejected: '已拒绝',
  'rolled-back': '已回滚',
}
const TYPE_LABELS: Record<string, string> = {
  skill: '技能',
  guardrail: '护栏',
  'planning-policy': '规划策略',
  prompt: '提示词',
  memory: '记忆',
  knowledge: '知识',
  'context-policy': '上下文策略',
  tool: '工具',
}
const VERDICT_LABELS: Record<string, string> = {
  accept: '通过',
  reject: '否决',
  inconclusive: '无法判定',
}
const TRANSITION_LABELS: Record<string, string> = {
  review: '送审',
  trial: '试用',
  promoted: '批准生效',
  rejected: '拒绝',
  'rolled-back': '回滚',
}
function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}
function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type
}
function verdictLabel(verdict: string): string {
  return VERDICT_LABELS[verdict] ?? verdict
}
function transitionLabel(to: string): string {
  return TRANSITION_LABELS[to] ?? to
}
function originLabel(origin: string): string {
  return origin === 'loop' ? '自动发现' : '手动'
}

export function LearningPanel({ client }: LearningPanelProps) {
  const [proposals, setProposals] = useState<LearningProposalDto[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()

  const refresh = useCallback(async () => {
    try {
      setProposals([...(await client.listLearningProposals({}))])
      setError(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [client])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runLoop = useCallback(async () => {
    setBusy(true)
    setNotice(undefined)
    try {
      const report = (await client.runLearningLoop()) as {
        proposalsCreated: string[]
        skippedDuplicates: number
      }
      setNotice(
        `慢循环：新建 ${report.proposalsCreated.length} 个提案，跳过 ${report.skippedDuplicates} 个重复`,
      )
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [client, refresh])

  const experiment = useCallback(
    async (proposalId: string) => {
      setBusy(true)
      setNotice(undefined)
      try {
        const report = (await client.runLearningExperiment(proposalId)) as {
          verdict: string
          metrics: Record<string, number>
        }
        setNotice(
          `实验结论：${verdictLabel(report.verdict)}（${JSON.stringify(report.metrics)}）`,
        )
        await refresh()
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(false)
      }
    },
    [client, refresh],
  )

  const transition = useCallback(
    async (
      proposal: LearningProposalDto,
      to: 'review' | 'trial' | 'promoted' | 'rejected' | 'rolled-back',
    ) => {
      setBusy(true)
      setNotice(undefined)
      try {
        await client.transitionLearningProposal({
          proposalId: proposal.id,
          to,
          expectedVersion: proposal.version,
          reason: `web console: ${to}`,
        })
        setNotice(`${proposal.targetKey} → ${transitionLabel(to)}`)
        await refresh()
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(false)
      }
    },
    [client, refresh],
  )

  const monitor = useCallback(async () => {
    setBusy(true)
    setNotice(undefined)
    try {
      const report = (await client.monitorLearningDrift()) as {
        report: { checked: { verdict: string; metric: string }[] }
      }
      setNotice(
        `漂移检查：${report.report.checked.length} 项受检` +
          (report.report.checked
            .map((c) => `${c.metric}=${verdictLabel(c.verdict)}`)
            .join('，') || ''),
      )
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [client])

  return (
    <section className="panel" aria-label="learning">
      <header>
        <h2>学习</h2>
        <button type="button" onClick={() => void runLoop()} disabled={busy}>
          运行慢循环
        </button>
        <button type="button" onClick={() => void monitor()} disabled={busy}>
          漂移检查
        </button>
        <button type="button" onClick={() => void refresh()} disabled={busy}>
          刷新
        </button>
      </header>
      {error !== undefined ? <p role="alert">{error}</p> : null}
      {notice !== undefined ? <p className="notice">{notice}</p> : null}
      {proposals.length === 0 ? (
        <p className="empty">还没有改进提案。</p>
      ) : (
        <ul className="learning-list">
          {proposals.map((proposal) => (
            <li key={proposal.id} className="learning-proposal">
              <span className={`badge badge-${proposal.status}`}>
                {statusLabel(proposal.status)}
              </span>
              <span className="proposal-target">{proposal.targetKey}</span>
              <span className="proposal-meta">
                L{proposal.autonomyLevel} · {typeLabel(proposal.type)} ·{' '}
                {originLabel(proposal.origin)}
              </span>
              <span className="proposal-actions">
                {proposal.status === 'draft' ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void experiment(proposal.id)}
                      disabled={busy}
                    >
                      隔离实验
                    </button>
                    <button
                      type="button"
                      onClick={() => void transition(proposal, 'review')}
                      disabled={busy}
                    >
                      送审
                    </button>
                    <button
                      type="button"
                      onClick={() => void transition(proposal, 'rejected')}
                      disabled={busy}
                    >
                      拒绝
                    </button>
                  </>
                ) : null}
                {proposal.status === 'review' ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void transition(proposal, 'trial')}
                      disabled={busy}
                    >
                      试用
                    </button>
                    <button
                      type="button"
                      onClick={() => void transition(proposal, 'rejected')}
                      disabled={busy}
                    >
                      拒绝
                    </button>
                  </>
                ) : null}
                {proposal.status === 'trial' ? (
                  <button
                    type="button"
                    onClick={() => void transition(proposal, 'promoted')}
                    disabled={busy}
                  >
                    批准生效
                  </button>
                ) : null}
                {proposal.status === 'promoted' ? (
                  <button
                    type="button"
                    onClick={() => void transition(proposal, 'rolled-back')}
                    disabled={busy}
                  >
                    回滚
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
