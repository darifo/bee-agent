import { buildContextManifest, estimateTokens } from './context-manifest.ts'
import type {
  ContextManifest,
  ContextOmission,
  ContextSectionDraft,
  SectionKind,
} from './context-manifest.ts'

/**
 * Context budget and compression (architecture §10.4, v1 refactor plan §5.2
 * P2-6): assembles the model context under a token budget, in priority order,
 * while never dropping the protected content — pending approvals, unconsumed
 * tool results, active plan constraints, failure reasons, artifact
 * references, memory provenance, and permission boundaries. A deterministic
 * truncating compressor stands in for a real summarizer.
 */

/** §10.4 assembly priorities; lower number = higher priority. */
export const SECTION_PRIORITIES = {
  safety: 1,
  goal: 2,
  world: 3,
  recentItems: 4,
  evidence: 5,
  skill: 6,
  tool: 7,
  history: 8,
} as const
export type SectionPriority =
  (typeof SECTION_PRIORITIES)[keyof typeof SECTION_PRIORITIES]

/** Content that compression may never drop or elide. */
export const PROTECTED_CONTENT = [
  'pending-approval',
  'unconsumed-tool-result',
  'active-plan-constraint',
  'failure-reason',
  'artifact-reference',
  'memory-citation',
  'permission-boundary',
] as const
export type ProtectedContent = (typeof PROTECTED_CONTENT)[number]

/** A section proposed for the model context, before budget decisions. */
export interface PromptSection {
  /** Stable id used in omissions (defaults to the first source id). */
  readonly id: string
  readonly kind: SectionKind
  readonly priority: number
  readonly content: string
  readonly sourceIds?: readonly string[] | undefined
  readonly rendererVersion?: string | undefined
  /** Why this section must never be dropped or compressed away. */
  readonly protectedBy?: readonly ProtectedContent[] | undefined
}

export interface ContextAllocation {
  /** Included sections in priority order. */
  readonly sections: readonly PromptSection[]
  readonly omissions: readonly ContextOmission[]
  readonly usedTokens: number
  readonly totalTokens: number
}

/**
 * Selects sections under `budgetTokens` in priority order (lowest priority
 * number first). Protected sections are always kept, even when that pushes
 * the total over budget; everything else is omitted once the budget is spent.
 */
export function allocateContextBudget(
  sections: readonly PromptSection[],
  budgetTokens: number,
): ContextAllocation {
  const sorted = [...sections].sort((a, b) => a.priority - b.priority)
  const included: PromptSection[] = []
  const omissions: ContextOmission[] = []
  let used = 0
  let total = 0
  for (const section of sections) total += estimateTokens(section.content)
  for (const section of sorted) {
    const tokens = estimateTokens(section.content)
    const isProtected = (section.protectedBy?.length ?? 0) > 0
    if (isProtected || used + tokens <= budgetTokens) {
      included.push(section)
      used += tokens
    } else {
      omissions.push({ sourceId: section.id, reason: 'budget-exceeded' })
    }
  }
  return { sections: included, omissions, usedTokens: used, totalTokens: total }
}

export interface CompressionPolicy {
  readonly version: string
  compress(content: string, maxTokens: number): string
}

/**
 * Deterministic compression baseline: keeps the head and elides the tail.
 * Real summarizers replace this; the protected-content rule still applies at
 * the allocation layer, never at the compressor.
 */
export const truncatingCompression: CompressionPolicy = {
  version: 'truncate-v1',
  compress(content, maxTokens) {
    const maxChars = Math.max(0, maxTokens) * 4
    if (content.length <= maxChars) return content
    return `${content.slice(0, maxChars - 1)}…`
  },
}

export interface CompileContextInput {
  readonly id: string
  readonly promptVersion: string
  readonly structureVersion: string
  readonly tokenBudget: number
  readonly sections: readonly PromptSection[]
  readonly compression?: CompressionPolicy | undefined
}

/**
 * The full context pipeline: compresses unprotected sections that overflow
 * the budget, allocates the budget (protected content survives), and builds
 * a manifest whose sections and omissions explain exactly where the tokens
 * went.
 */
export function compileContextManifest(
  input: CompileContextInput,
): ContextManifest {
  const compression = input.compression ?? truncatingCompression
  const prepared = input.sections.map((section) => {
    const isProtected = (section.protectedBy?.length ?? 0) > 0
    if (isProtected) return section
    if (estimateTokens(section.content) <= input.tokenBudget) return section
    return {
      ...section,
      content: compression.compress(section.content, input.tokenBudget),
    }
  })
  const allocation = allocateContextBudget(prepared, input.tokenBudget)
  const drafts: ContextSectionDraft[] = allocation.sections.map((section) => ({
    kind: section.kind,
    sourceIds: section.sourceIds ?? [section.id],
    rendererVersion: section.rendererVersion ?? 'v1',
    priority: section.priority,
    content: section.content,
  }))
  return buildContextManifest({
    id: input.id,
    promptVersion: input.promptVersion,
    structureVersion: input.structureVersion,
    tokenBudget: input.tokenBudget,
    sections: drafts,
    omissions: allocation.omissions,
  })
}
