import { canonicalJson } from '@bee-agent/kernel'
import { toSkillSummary } from './skill.ts'
import type { Skill, SkillSummary } from './skill.ts'

/**
 * Skill Registry (architecture §10.5/§14.1, v1 refactor plan §5.2 P2-7):
 * two-stage loading. The index stage exposes only summaries (name, short
 * description, tags, risk, token estimate); the resolve stage loads a full
 * skill after a match. Unmatched skills never cost context beyond the index.
 */

export class SkillRegistry {
  readonly #skills = new Map<string, Skill>()

  /** Registers a skill; duplicate ids fail loud (namespace conflict). */
  register(skill: Skill): void {
    if (this.#skills.has(skill.id)) {
      throw new Error(`Skill '${skill.id}' is already registered`)
    }
    this.#skills.set(skill.id, skill)
  }

  /** The cheap index stage: every skill's summary, no full content. */
  index(): readonly SkillSummary[] {
    return [...this.#skills.values()].map(toSkillSummary)
  }

  /** The resolve stage: the full skill for a matched id. */
  resolve(id: string): Skill | undefined {
    return this.#skills.get(id)
  }

  /** Resolves several matched ids, skipping ids that are not registered. */
  resolveMany(ids: readonly string[]): readonly Skill[] {
    const skills: Skill[] = []
    for (const id of ids) {
      const skill = this.#skills.get(id)
      if (skill !== undefined) skills.push(skill)
    }
    return skills
  }

  /** Finds candidate summaries whose name, summary, or tags match all terms. */
  search(query: string): readonly SkillSummary[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return []
    return [...this.#skills.values()].map(toSkillSummary).filter((summary) => {
      const haystack =
        `${summary.name} ${summary.summary} ${summary.tags.join(' ')}`.toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
  }
}

/** A reference evaluator that applies a skill to an input. */
export type SkillEvaluator = (input: unknown) => Promise<unknown> | unknown

export interface SkillEvalResult {
  readonly name: string
  readonly passed: boolean
  readonly actual: unknown
  readonly expected: unknown
}

/**
 * Basic Skill eval skeleton (architecture §14.1): runs every eval case
 * against an injected evaluator and reports pass/fail with the actual and
 * expected outputs. The evaluator is injected so tests can be deterministic.
 */
export async function evaluateSkill(
  skill: Skill,
  evaluator: SkillEvaluator,
): Promise<SkillEvalResult[]> {
  const results: SkillEvalResult[] = []
  for (const evalCase of skill.evalCases) {
    const actual = await evaluator(evalCase.input)
    results.push({
      name: evalCase.name,
      passed: canonicalJson(actual) === canonicalJson(evalCase.expectedOutput),
      actual,
      expected: evalCase.expectedOutput,
    })
  }
  return results
}
