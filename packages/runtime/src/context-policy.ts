import { createHash } from 'node:crypto'
import { canonicalJson } from '@bee-agent/kernel'
import type { LlmMessage } from './llm-runtime.ts'

/**
 * Context policy, level 1 (the cheapest rung of the compaction ladder the
 * benchmark agents converge on): old tool results are elided from the
 * model-visible request under a token budget, as a pure projection —
 * `state.history` keeps full fidelity, checkpoint digests keep rebuilding
 * from Chronicle, and the projection is re-derived deterministically on
 * every generation (the dsh "surface fold" approach: fold the view, never
 * the log).
 *
 * Later rungs (LLM summarization of whole spans, cache-aware deletion)
 * compose on top; this one needs no model calls and no new event types —
 * the elided placeholder travels inside the recorded request bundle, so
 * the audit trail already shows exactly what the model stopped seeing.
 */

export interface ToolResultCompactionPolicy {
  /**
   * Soft total budget for tool-result messages in one model-visible
   * request. Protected results (errors, the recent window) survive even
   * when that pushes the total over budget.
   */
  readonly toolResultBudgetTokens: number
  /**
   * The N most recent tool results are never elided: they are where the
   * model is working, and keeping them preserves the prompt-cache prefix
   * of the active step.
   */
  readonly keepRecentToolResults: number
}

export const DEFAULT_TOOL_RESULT_COMPACTION: ToolResultCompactionPolicy = {
  toolResultBudgetTokens: 4096,
  keepRecentToolResults: 4,
}

/** One elided tool result, positioned by its bundle message index. */
export interface ContextElision {
  /** Index in the assembled message array (`message:N` manifest source). */
  readonly messageIndex: number
  readonly toolId: string
  readonly originalTokens: number
  /** Full sha256 of the original content, for audit and retrieval. */
  readonly digest: string
}

export interface ProjectedHistory {
  readonly messages: readonly LlmMessage[]
  readonly elisions: readonly ContextElision[]
}

export function estimateMessageTokens(content: string): number {
  return Math.ceil(content.length / 4)
}

function isToolMessage(
  message: LlmMessage,
): message is Extract<LlmMessage, { role: 'tool' }> {
  return message.role === 'tool'
}

function elisionPlaceholder(elision: ContextElision): string {
  const shortDigest = elision.digest.slice(
    'sha256:'.length,
    'sha256:'.length + 8,
  )
  return `[elided by context policy: ~${elision.originalTokens}-token tool result for '${elision.toolId}' (${shortDigest}); the full output is retained in this thread's durable log]`
}

/**
 * Projects history under the tool-result budget. Elision order is oldest
 * first; error results are protected (failure reasons are what the model
 * must still see to correct course), as are the most recent results. The
 * output is a deterministic function of (history, policy).
 */
export function projectHistory(
  history: readonly LlmMessage[],
  policy: ToolResultCompactionPolicy = DEFAULT_TOOL_RESULT_COMPACTION,
): ProjectedHistory {
  const toolIndexes: number[] = []
  history.forEach((message, index) => {
    if (isToolMessage(message)) toolIndexes.push(index)
  })
  if (toolIndexes.length === 0) return { messages: history, elisions: [] }

  const recent = new Set(toolIndexes.slice(-policy.keepRecentToolResults))
  const elide = new Set<number>()
  const tokensOf = (index: number): number =>
    estimateMessageTokens(history[index]?.content ?? '')
  let total = toolIndexes.reduce((sum, index) => sum + tokensOf(index), 0)
  for (const index of toolIndexes) {
    if (total <= policy.toolResultBudgetTokens) break
    const message = history[index]
    if (message === undefined || !isToolMessage(message)) continue
    if (recent.has(index) || message.isError === true) continue
    elide.add(index)
    total -= tokensOf(index)
  }

  if (elide.size === 0) return { messages: history, elisions: [] }

  const elisions: ContextElision[] = []
  const messages = history.map((message, index) => {
    if (!elide.has(index)) return message
    const tool = message as Extract<LlmMessage, { role: 'tool' }>
    const elision: ContextElision = {
      messageIndex: index,
      toolId: tool.toolId,
      originalTokens: tokensOf(index),
      digest: `sha256:${createHash('sha256').update(canonicalJson(tool.content)).digest('hex')}`,
    }
    elisions.push(elision)
    return {
      role: 'tool' as const,
      callId: tool.callId,
      toolId: tool.toolId,
      content: elisionPlaceholder(elision),
      ...(tool.isError === undefined ? {} : { isError: tool.isError }),
    }
  })
  return { messages, elisions }
}

/** Manifest-omission form of the elisions, for the request audit trail. */
export function elisionsToOmissions(
  elisions: readonly ContextElision[],
): readonly { sourceId: string; reason: string }[] {
  return elisions.map((elision) => ({
    sourceId: `message:${elision.messageIndex}`,
    reason: `context-policy:tool-result-budget (${elision.originalTokens} tokens, ${elision.digest})`,
  }))
}
