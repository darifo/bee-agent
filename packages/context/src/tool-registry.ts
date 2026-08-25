import { toToolSummary } from './tool.ts'
import type { ToolDefinition, ToolSpec, ToolSummary } from './tool.ts'

/**
 * Tool Index and Resolver (architecture §10.5, v1 refactor plan §5.2 P2-8):
 * core small tools stay resident; long-tail tools (MCP, external APIs) are
 * searched by summary and only resolved on match, within a token budget.
 * Resolved specs are immutable snapshots, so a turn pins the tool versions it
 * started with.
 */

export interface ToolIndex {
  /** Summaries for every non-resident tool, for the lazy-loadable index. */
  index(): readonly ToolSummary[]
  /**
   * Candidate summaries whose id/description/tags match every term, taking
   * the highest-relevance matches until the token budget is exhausted.
   */
  search(query: string, budgetTokens: number): readonly ToolSummary[]
}

export interface ToolResolver {
  /** Full specs for the given ids, preserving order and skipping unknowns. */
  resolve(ids: readonly string[]): readonly ToolSpec[]
  /** Full specs for resident (always-loaded) tools. */
  residentSpecs(): readonly ToolSpec[]
}

export class ToolRegistry implements ToolIndex, ToolResolver {
  readonly #tools = new Map<string, ToolDefinition>()

  /** Registers a tool; duplicate ids fail loud (namespace conflict). */
  register(definition: ToolDefinition): void {
    if (this.#tools.has(definition.id)) {
      throw new Error(`Tool '${definition.id}' is already registered`)
    }
    this.#tools.set(definition.id, definition)
  }

  index(): readonly ToolSummary[] {
    return [...this.#tools.values()]
      .filter((tool) => !(tool.resident ?? false))
      .map(toToolSummary)
  }

  search(query: string, budgetTokens: number): readonly ToolSummary[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return []
    const candidates = this.index().filter((summary) => {
      const haystack =
        `${summary.id} ${summary.description} ${summary.tags.join(' ')}`.toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
    const picked: ToolSummary[] = []
    let used = 0
    for (const summary of candidates) {
      if (used + summary.tokenEstimate > budgetTokens) continue
      picked.push(summary)
      used += summary.tokenEstimate
    }
    return picked
  }

  resolve(ids: readonly string[]): readonly ToolSpec[] {
    const specs: ToolSpec[] = []
    for (const id of ids) {
      const tool = this.#tools.get(id)
      if (tool !== undefined) {
        specs.push({
          id: tool.id,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })
      }
    }
    return specs
  }

  residentSpecs(): readonly ToolSpec[] {
    return [...this.#tools.values()]
      .filter((tool) => tool.resident ?? false)
      .map(({ id, description, inputSchema }) => ({
        id,
        description,
        inputSchema,
      }))
  }
}
