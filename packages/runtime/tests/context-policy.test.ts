import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TOOL_RESULT_COMPACTION,
  elisionsToOmissions,
  projectHistory,
} from '../src/context-policy.ts'
import type { LlmMessage } from '../src/llm-runtime.ts'

function tool(callId: string, content: string, isError?: boolean): LlmMessage {
  return {
    role: 'tool',
    callId,
    toolId: `tool_${callId}`,
    content,
    ...(isError === undefined ? {} : { isError }),
  }
}

function user(content: string): LlmMessage {
  return { role: 'user', content }
}

describe('projectHistory', () => {
  it('is a no-op within the recent window', () => {
    const history = [user('hi'), tool('c1', 'ok'), tool('c2', 'ok')]
    const projected = projectHistory(history, {
      toolResultBudgetTokens: 10,
      keepRecentToolResults: 4,
    })
    expect(projected.messages).toEqual(history)
    expect(projected.elisions).toEqual([])
  })

  it('elides the oldest tool results beyond the budget and recent window', () => {
    const history = [
      user('go'),
      tool('c1', 'a'.repeat(400)),
      tool('c2', 'b'.repeat(400)),
      tool('c3', 'c'.repeat(400)),
      tool('c4', 'd'.repeat(400)),
      tool('c5', 'e'.repeat(400)),
      tool('c6', 'f'.repeat(400)),
    ]
    const projected = projectHistory(history, {
      toolResultBudgetTokens: 150,
      keepRecentToolResults: 2,
    })
    // Candidates are c1..c4 (100 tokens each); the protected recent window
    // (c5+c6, 200 tokens) alone exceeds the soft budget, so every candidate
    // is elided — protected content survives even over budget.
    expect(projected.elisions.map((elision) => elision.messageIndex)).toEqual([
      1, 2, 3, 4,
    ])
    const elided = projected.messages[1] as Extract<
      LlmMessage,
      { role: 'tool' }
    >
    expect(elided.callId).toBe('c1')
    expect(elided.content).toMatch(/elided by context policy/)
    expect(elided.content).toMatch(/tool_c1/)
    // The recent window and untouched messages survive verbatim.
    expect(projected.messages[5]).toEqual(tool('c5', 'e'.repeat(400)))
    expect(projected.messages[0]).toEqual(user('go'))
  })

  it('protects error results from elision', () => {
    const history = [
      user('go'),
      tool('c1', 'a'.repeat(400), true),
      tool('c2', 'b'.repeat(400)),
      tool('c3', 'c'.repeat(400)),
    ]
    const projected = projectHistory(history, {
      toolResultBudgetTokens: 10,
      keepRecentToolResults: 1,
    })
    // c1 is an error (protected); only c2 is eligible and gets elided.
    expect(projected.elisions.map((elision) => elision.messageIndex)).toEqual([
      2,
    ])
    const kept = projected.messages[1] as Extract<LlmMessage, { role: 'tool' }>
    expect(kept.content).toBe('a'.repeat(400))
    expect(kept.isError).toBe(true)
  })

  it('never drops pairing fields or flags on the placeholder', () => {
    const history = [user('go'), tool('c1', 'a'.repeat(400), true)]
    const projected = projectHistory(history, {
      toolResultBudgetTokens: 0,
      keepRecentToolResults: 0,
    })
    // isError protects it; force elision by removing the flag.
    const unprotected = projectHistory(
      [user('go'), tool('c1', 'x'.repeat(400))],
      {
        toolResultBudgetTokens: 0,
        keepRecentToolResults: 0,
      },
    )
    const elided = unprotected.messages[1] as Extract<
      LlmMessage,
      { role: 'tool' }
    >
    expect(elided.callId).toBe('c1')
    expect(elided.toolId).toBe('tool_c1')
    expect('isError' in elided).toBe(false)
    expect(projected.elisions).toEqual([])
  })

  it('is deterministic for the same input', () => {
    const history = [
      user('go'),
      tool('c1', 'a'.repeat(400)),
      tool('c2', 'b'.repeat(400)),
      tool('c3', 'c'.repeat(400)),
    ]
    const policy = { toolResultBudgetTokens: 10, keepRecentToolResults: 1 }
    expect(projectHistory(history, policy)).toEqual(
      projectHistory(history, policy),
    )
  })

  it('maps elisions to manifest omissions', () => {
    const history = [
      user('go'),
      tool('c1', 'a'.repeat(400)),
      tool('c2', 'b'.repeat(400)),
      tool('c3', 'c'.repeat(400)),
    ]
    const projected = projectHistory(history, {
      toolResultBudgetTokens: 10,
      keepRecentToolResults: 1,
    })
    const omissions = elisionsToOmissions(projected.elisions)
    expect(omissions[0]?.sourceId).toBe('message:1')
    expect(omissions[0]?.reason).toMatch(/context-policy:tool-result-budget/)
  })

  it('defaults protect a reasonable recent window', () => {
    expect(DEFAULT_TOOL_RESULT_COMPACTION.keepRecentToolResults).toBe(4)
    expect(DEFAULT_TOOL_RESULT_COMPACTION.toolResultBudgetTokens).toBe(4096)
  })
})
