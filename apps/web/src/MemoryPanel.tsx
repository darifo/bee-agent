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
        <h2>Memory</h2>
        <button type="button" onClick={() => void refresh()} disabled={busy}>
          Refresh
        </button>
        <button
          type="button"
          onClick={() => void consolidate()}
          disabled={busy}
        >
          Consolidate
        </button>
      </header>
      {error !== undefined ? <p role="alert">{error}</p> : null}
      {claims.length === 0 ? (
        <p className="empty">Nothing remembered yet.</p>
      ) : (
        <ul className="memory-list">
          {claims.map((claim) => (
            <li key={claim.id} className="memory-claim">
              <span className={`badge badge-${claim.status}`}>
                {claim.status}
              </span>
              <span className="claim-kind">{claim.kind}</span>
              <span className="claim-statement">{claim.statement}</span>
              {claim.status === 'active' ? (
                <button
                  type="button"
                  onClick={() => void forget(claim.id)}
                  disabled={busy}
                  aria-label={`forget ${claim.id}`}
                >
                  Forget
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
