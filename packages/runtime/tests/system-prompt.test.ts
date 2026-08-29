import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SYSTEM_PROMPT_TOKEN_BUDGET,
  SystemPromptAssembler,
} from '../src/system-prompt.ts'

describe('SystemPromptAssembler', () => {
  it('joins sections in priority order under the budget', async () => {
    const assembler = new SystemPromptAssembler({
      promptVersion: 'bee-system@1.0.0',
      structureVersion: 'sha256:test',
      sections: [
        { id: 'environment', priority: 20, content: 'Env details.' },
        { id: 'instructions', priority: 10, content: 'Do the task well.' },
        { id: 'identity', priority: 1, content: 'You are Bee.' },
      ],
    })
    const prompt = await assembler.resolve()
    expect(prompt.content).toBe(
      'You are Bee.\n\nDo the task well.\n\nEnv details.',
    )
    expect(prompt.omittedSectionIds).toEqual([])
    expect(prompt.manifest.promptVersion).toBe('bee-system@1.0.0')
    expect(prompt.manifest.sections.map((section) => section.priority)).toEqual(
      [1, 10, 20],
    )
  })

  it('drops the lowest-priority unprotected sections over budget', async () => {
    const assembler = new SystemPromptAssembler({
      promptVersion: 'p@1',
      structureVersion: 'sha256:test',
      tokenBudget: 10,
      sections: [
        {
          id: 'identity',
          priority: 1,
          content: 'You are Bee.',
          protectedBy: ['permission-boundary'],
        },
        { id: 'tips', priority: 50, content: 'x'.repeat(200) },
        { id: 'notes', priority: 60, content: 'y'.repeat(200) },
      ],
    })
    const prompt = await assembler.resolve()
    expect(prompt.content).toBe('You are Bee.')
    // The protected identity section survives; both overflow sections are
    // omitted once the (protected-heavy) budget is spent.
    expect(prompt.omittedSectionIds).toEqual(['tips', 'notes'])
    expect(
      prompt.manifest.omissions.map((omission) => omission.reason),
    ).toEqual(['budget-exceeded', 'budget-exceeded'])
  })

  it('memoizes: resolve returns the identical object', async () => {
    let calls = 0
    const assembler = new SystemPromptAssembler({
      promptVersion: 'p@1',
      structureVersion: 'sha256:test',
      sections: () => {
        calls += 1
        return [{ id: 'identity', priority: 1, content: 'You are Bee.' }]
      },
    })
    const first = await assembler.resolve()
    const second = await assembler.resolve()
    expect(second).toBe(first)
    expect(calls).toBe(1)
  })

  it('defaults the budget and records it on the manifest', async () => {
    const assembler = new SystemPromptAssembler({
      promptVersion: 'p@1',
      structureVersion: 'sha256:test',
      sections: [{ id: 'identity', priority: 1, content: 'You are Bee.' }],
    })
    const prompt = await assembler.resolve()
    expect(prompt.manifest.tokenBudget).toBe(DEFAULT_SYSTEM_PROMPT_TOKEN_BUDGET)
    // Deterministic for replay: same inputs, same digests.
    const again = new SystemPromptAssembler({
      promptVersion: 'p@1',
      structureVersion: 'sha256:test',
      sections: [{ id: 'identity', priority: 1, content: 'You are Bee.' }],
    })
    expect((await again.resolve()).manifest.sections[0]?.digest).toBe(
      prompt.manifest.sections[0]?.digest,
    )
  })
})
