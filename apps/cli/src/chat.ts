import type { BeeAgentClient, TurnResult } from '@bee-agent/client'
import type { ThreadId } from '@bee-agent/thread/protocol'

export interface PendingApproval {
  readonly approvalId: string
  readonly title: string
}

/**
 * Decides a suspended turn's approval. Callers implement the prompt (CLI
 * reads a line, tests feed a script) so the loop itself stays deterministic.
 */
export type ApprovalDecider = (
  approval: PendingApproval,
) => Promise<'approved' | 'rejected'>

/**
 * Runs one user message to a stable boundary: starts the turn, then keeps
 * resolving approvals until the turn completes, fails, or is cancelled.
 * Tools execute inside the server loop; only approval needs client input.
 */
export async function runTurnToCompletion(
  api: BeeAgentClient,
  threadId: ThreadId,
  input: string,
  decide: ApprovalDecider,
): Promise<TurnResult> {
  let result = await api.createTurn(threadId, { input })
  while (result.status === 'suspended') {
    const decision = await decide(result.approval)
    result = await api.resolveApproval(
      threadId,
      result.turn.id,
      result.approval.approvalId,
      decision,
    )
  }
  return result
}
