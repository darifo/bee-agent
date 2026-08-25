import { z } from 'zod'
import { estimateTokens } from './context-manifest.ts'

/**
 * Skill model (architecture §14.1, v1 refactor plan §5.2 P2-7): a package of
 * procedural knowledge. The full manifest is only loaded after a match; the
 * index stage exposes just a summary (name, short description, tags, risk,
 * and a token cost estimate) so unmatched skills cost almost nothing.
 */

export const SkillRiskLevelSchema = z.enum(['low', 'medium', 'high'])
export type SkillRiskLevel = z.infer<typeof SkillRiskLevelSchema>

/** One eval case: an input and the expected output for a reference evaluator. */
export const SkillEvalCaseSchema = z.object({
  name: z.string().min(1),
  input: z.unknown(),
  expectedOutput: z.unknown(),
})
export type SkillEvalCase = z.infer<typeof SkillEvalCaseSchema>

export const SkillManifestSchema = z.object({
  /** Stable, namespace-qualified id (e.g. `bee.skills.summarize`). */
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  /** Short summary exposed during the index stage. */
  summary: z.string().min(1),
  /** Full instructions, loaded only on resolve. */
  description: z.string().min(1),
  tags: z.array(z.string().min(1)),
  riskLevel: SkillRiskLevelSchema,
  /** Capability/permission ids; enforced by execution in Phase 3. */
  requiredCapabilities: z.array(z.string().min(1)),
  requiredPermissions: z.array(z.string().min(1)),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  evalCases: z.array(SkillEvalCaseSchema),
  knownFailureModes: z.array(z.string().min(1)),
})
export type Skill = z.infer<typeof SkillManifestSchema>

export const SkillSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  summary: z.string().min(1),
  tags: z.array(z.string().min(1)),
  riskLevel: SkillRiskLevelSchema,
  /** Approximate token cost of the full skill, for budgeting decisions. */
  tokenEstimate: z.number().int().nonnegative(),
})
export type SkillSummary = z.infer<typeof SkillSummarySchema>

/** Derives the index-stage summary from a full skill. */
export function toSkillSummary(skill: Skill): SkillSummary {
  return SkillSummarySchema.parse({
    id: skill.id,
    name: skill.name,
    version: skill.version,
    summary: skill.summary,
    tags: skill.tags,
    riskLevel: skill.riskLevel,
    tokenEstimate: estimateSkillTokens(skill),
  })
}

/** Token cost of exposing a summary (the index-stage cost). */
export function estimateSummaryTokens(summary: SkillSummary): number {
  return estimateTokens(
    `${summary.name}: ${summary.summary} [${summary.tags.join(', ')}]`,
  )
}

/** Token cost of exposing a skill in full (description, schemas, failure modes). */
export function estimateSkillTokens(skill: Skill): number {
  return estimateTokens(
    [
      skill.description,
      JSON.stringify(skill.inputSchema),
      JSON.stringify(skill.outputSchema),
      ...skill.knownFailureModes,
    ].join(' '),
  )
}
