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
        `loop: created ${report.proposalsCreated.length}, skipped ${report.skippedDuplicates} duplicates`,
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
          `experiment: ${report.verdict} (${JSON.stringify(report.metrics)})`,
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
        setNotice(`${proposal.targetKey} → ${to}`)
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
        `drift: ${report.report.checked.length} checked` +
          (report.report.checked
            .map((c) => `${c.metric}=${c.verdict}`)
            .join(', ') || ''),
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
        <h2>Learning</h2>
        <button type="button" onClick={() => void runLoop()} disabled={busy}>
          Run loop
        </button>
        <button type="button" onClick={() => void monitor()} disabled={busy}>
          Drift check
        </button>
        <button type="button" onClick={() => void refresh()} disabled={busy}>
          Refresh
        </button>
      </header>
      {error !== undefined ? <p role="alert">{error}</p> : null}
      {notice !== undefined ? <p className="notice">{notice}</p> : null}
      {proposals.length === 0 ? (
        <p className="empty">No improvement proposals yet.</p>
      ) : (
        <ul className="learning-list">
          {proposals.map((proposal) => (
            <li key={proposal.id} className="learning-proposal">
              <span className={`badge badge-${proposal.status}`}>
                {proposal.status}
              </span>
              <span className="proposal-target">{proposal.targetKey}</span>
              <span className="proposal-meta">
                L{proposal.autonomyLevel} · {proposal.type} · {proposal.origin}
              </span>
              <span className="proposal-actions">
                {proposal.status === 'draft' ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void experiment(proposal.id)}
                      disabled={busy}
                    >
                      Experiment
                    </button>
                    <button
                      type="button"
                      onClick={() => void transition(proposal, 'review')}
                      disabled={busy}
                    >
                      Review
                    </button>
                    <button
                      type="button"
                      onClick={() => void transition(proposal, 'rejected')}
                      disabled={busy}
                    >
                      Reject
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
                      Trial
                    </button>
                    <button
                      type="button"
                      onClick={() => void transition(proposal, 'rejected')}
                      disabled={busy}
                    >
                      Reject
                    </button>
                  </>
                ) : null}
                {proposal.status === 'trial' ? (
                  <button
                    type="button"
                    onClick={() => void transition(proposal, 'promoted')}
                    disabled={busy}
                  >
                    Promote
                  </button>
                ) : null}
                {proposal.status === 'promoted' ? (
                  <button
                    type="button"
                    onClick={() => void transition(proposal, 'rolled-back')}
                    disabled={busy}
                  >
                    Roll back
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
