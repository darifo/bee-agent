import { estimateTokens } from './context-manifest.ts'

/**
 * Tool model (architecture §10.5, v1 refactor plan §5.2 P2-8): the tool
 * analog of the Skill Registry. A `ToolSpec` is the full declaration the
 * model needs (id, description, input JSON Schema); the index stage exposes
 * only a summary (id, description, tags) so long-tail tools cost almost
 * nothing until they are resolved.
 */

/** The full tool declaration exposed to the model. */
export interface ToolSpec {
  readonly id: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

/** A registered tool: the spec plus search/lazy-load metadata. */
export interface ToolDefinition extends ToolSpec {
  readonly tags?: readonly string[] | undefined
  /** Core small tools are always loaded; long-tail tools are lazy. */
  readonly resident?: boolean | undefined
}

/** The index-stage summary: no schema, just enough to match and budget. */
export interface ToolSummary {
  readonly id: string
  readonly description: string
  readonly tags: readonly string[]
  readonly resident: boolean
  /** Token cost of the full spec, for budgeting the resolve. */
  readonly tokenEstimate: number
}

/** Token cost of exposing a tool's full spec (description + input schema). */
export function estimateToolTokens(spec: ToolSpec): number {
  return estimateTokens(
    `${spec.description} ${JSON.stringify(spec.inputSchema)}`,
  )
}

/** Token cost of exposing a tool's summary (description, no schema). */
export function estimateToolSummaryTokens(summary: ToolSummary): number {
  return estimateTokens(
    `${summary.id}: ${summary.description} [${summary.tags.join(', ')}]`,
  )
}

/** Derives the index-stage summary from a registered tool. */
export function toToolSummary(definition: ToolDefinition): ToolSummary {
  const resident = definition.resident ?? false
  return {
    id: definition.id,
    description: definition.description,
    tags: [...(definition.tags ?? [])],
    resident,
    tokenEstimate: estimateToolTokens(definition),
  }
}

export interface ToolContextCost {
  /** Cost of exposing every tool's full spec (the naive baseline). */
  readonly baselineTokens: number
  /** Cost of exposing the resident tools' full specs. */
  readonly residentTokens: number
  /** Two-stage cost: resident full specs + non-resident summaries. */
  readonly indexedTokens: number
}

/** Compares the naive full-tool baseline against the two-stage cost. */
export function measureToolContextCost(
  resident: readonly ToolSpec[],
  summaries: readonly ToolSummary[],
): ToolContextCost {
  const residentTokens = resident.reduce(
    (sum, spec) => sum + estimateToolTokens(spec),
    0,
  )
  const longTailFull = summaries.reduce(
    (sum, summary) => sum + summary.tokenEstimate,
    0,
  )
  const longTailIndexed = summaries.reduce(
    (sum, summary) => sum + estimateToolSummaryTokens(summary),
    0,
  )
  return {
    baselineTokens: residentTokens + longTailFull,
    residentTokens,
    indexedTokens: residentTokens + longTailIndexed,
  }
}
