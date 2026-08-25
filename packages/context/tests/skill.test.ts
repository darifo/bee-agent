import { describe, expect, it } from 'vitest'
import {
  SkillManifestSchema,
  estimateSkillTokens,
  estimateSummaryTokens,
} from '../src/skill.ts'
import type { Skill } from '../src/skill.ts'
import { SkillRegistry, evaluateSkill } from '../src/skill-registry.ts'
import type { SkillEvaluator } from '../src/skill-registry.ts'

function skillFixture(overrides: Partial<Skill> = {}): Skill {
  return SkillManifestSchema.parse({
    id: 'bee.skills.summarize',
    name: 'Summarize',
    version: '1.0.0',
    summary: 'Summarize a long text into a short paragraph.',
    description:
      'Given a long document, produce a concise summary that preserves the key facts, numbers, and the overall conclusion. Prefer short sentences and plain language.'.repeat(
        6,
      ),
    tags: ['writing', 'summarize'],
    riskLevel: 'low',
    requiredCapabilities: ['llm'],
    requiredPermissions: ['memory:read'],
    inputSchema: { type: 'object' },
    outputSchema: { type: 'string' },
    evalCases: [
      { name: 'doubles two', input: 2, expectedOutput: 4 },
      { name: 'doubles three', input: 3, expectedOutput: 7 },
    ],
    knownFailureModes: ['Loses key numbers when the input is very short'],
    ...overrides,
  })
}

describe('Skill model', () => {
  it('round-trips a full manifest and derives its summary', () => {
    const skill = skillFixture()
    const summary = SkillManifestSchema.parse(skill)
    expect(summary.id).toBe('bee.skills.summarize')
    expect(summary.requiredCapabilities).toEqual(['llm'])
    expect(summary.requiredPermissions).toEqual(['memory:read'])
  })
})

describe('SkillRegistry', () => {
  it('indexes summaries and resolves the full skill on match', () => {
    const registry = new SkillRegistry()
    registry.register(skillFixture())

    const index = registry.index()
    expect(index).toHaveLength(1)
    expect(index[0]?.summary).toContain('Summarize a long text')
    expect(index[0]?.tokenEstimate).toBeGreaterThan(0)

    const matched = registry.search('summarize')
    expect(matched.map((s) => s.id)).toEqual(['bee.skills.summarize'])

    const full = registry.resolve(matched[0]!.id)
    expect(full?.description.length).toBeGreaterThan(100)
  })

  it('costs almost nothing when a query matches no skill', () => {
    const registry = new SkillRegistry()
    registry.register(skillFixture())

    const unmatched = registry.search('quantum physics')
    expect(unmatched).toEqual([])
  })

  it('exposes a far cheaper index than the full skill load', () => {
    const skill = skillFixture()
    const registry = new SkillRegistry()
    registry.register(skill)

    const summary = registry.index()[0]!
    expect(estimateSummaryTokens(summary)).toBeLessThan(
      estimateSkillTokens(skill),
    )
    // The summary carries the full-skill cost estimate for budgeting.
    expect(summary.tokenEstimate).toBe(estimateSkillTokens(skill))
  })

  it('fails loud on a duplicate skill id', () => {
    const registry = new SkillRegistry()
    registry.register(skillFixture())
    expect(() => registry.register(skillFixture())).toThrow(
      /already registered/,
    )
  })
})

describe('Skill eval skeleton', () => {
  it('reports pass/fail per case against an injected evaluator', async () => {
    const skill = skillFixture()
    const evaluator: SkillEvaluator = async (input) => (input as number) * 2

    const results = await evaluateSkill(skill, evaluator)
    expect(results.map((result) => result.passed)).toEqual([true, false])
    expect(results[1]?.actual).toBe(6)
    expect(results[1]?.expected).toBe(7)
  })
})
