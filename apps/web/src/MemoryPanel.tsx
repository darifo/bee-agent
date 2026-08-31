import { useCallback, useEffect, useState } from 'react'
import type { BeeAgentClient, MemoryClaimDto } from '@bee-agent/client'

export interface MemoryPanelProps {
  client: BeeAgentClient
}

/**
 * Memory governance view (v1 refactor plan §5.7 WF6-B): what Bee remembers,
 * in one list — every claim shows its status, and forgetting is one click
 * with a durable retraction behind it. Consolidation merges duplicates.
 */
const STATUS_LABELS: Record<string, string> = {
  active: '生效中',
  superseded: '已被取代',
  retracted: '已遗忘',
}
const KIND_LABELS: Record<string, string> = {
  preference: '偏好',
  fact: '事实',
  correction: '纠正',
  procedure: '用法',
}
function claimStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}
function claimKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}
function claimKindIcon(kind: string): string {
  if (kind === 'preference') return '♡'
  if (kind === 'fact') return '◆'
  if (kind === 'correction') return '↺'
  if (kind === 'procedure') return '⚙'
  return '•'
}

export function MemoryPanel({ client }: MemoryPanelProps) {
  const [claims, setClaims] = useState<MemoryClaimDto[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const refresh = useCallback(async () => {
    try {
      setClaims([...(await client.listMemoryClaims({}))])
      setError(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [client])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const forget = useCallback(
    async (claimId: string) => {
      setBusy(true)
      try {
        await client.forgetMemoryClaim(
          claimId,
          'forgotten from the web console',
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

  const consolidate = useCallback(async () => {
    setBusy(true)
    try {
      await client.consolidateMemory()
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [client, refresh])

  return (
    <section className="panel" aria-label="memory">
      <header>
        <h2>记忆</h2>
        <button type="button" onClick={() => void refresh()} disabled={busy}>
          刷新
        </button>
        <button
          type="button"
          onClick={() => void consolidate()}
          disabled={busy}
        >
          合并去重
        </button>
      </header>
      {error !== undefined ? <p role="alert">{error}</p> : null}
      {claims.length === 0 ? (
        <p className="empty">还没有记住任何东西。</p>
      ) : (
        <ul className="memory-list">
          {claims.map((claim) => (
            <li key={claim.id} className="memory-claim">
              <span className={`badge badge-${claim.status}`}>
                {claimStatusLabel(claim.status)}
              </span>
              <span className="claim-kind">
                {claimKindIcon(claim.kind)} {claimKindLabel(claim.kind)}
              </span>
              <span className="claim-statement">{claim.statement}</span>
              {claim.status === 'active' ? (
                <button
                  type="button"
                  onClick={() => void forget(claim.id)}
                  disabled={busy}
                  aria-label={`遗忘 ${claim.id}`}
                >
                  遗忘
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
