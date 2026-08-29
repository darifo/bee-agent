import {
  allocateContextBudget,
  buildContextManifest,
  type ContextManifest,
  type ProtectedContent,
  type PromptSection,
} from '@bee-agent/context'

/**
 * System prompt assembly (benchmark-driven hardening pass, step 6): the
 * model-visible request starts with one system message assembled from
 * prioritized sections under a token budget — the context package's
 * allocation machinery, finally on the live path.
 *
 * Cache discipline (the Claude Code lesson): the assembled prompt is
 * resolved once and then never changes for the lifetime of the assembler,
 * so the system message is a stable prefix the provider can cache. Dynamic
 * content must NOT go here — it belongs in late messages (the retrieve/plan
 * hooks already append those after history, which preserves the prefix).
 */

export const DEFAULT_SYSTEM_PROMPT_TOKEN_BUDGET = 2048

/** One system-prompt section before budget allocation. */
export interface SystemPromptSectionInput {
  /** Stable id used in omissions when the budget drops the section. */
  readonly id: string
  /** Lower renders first: identity before instructions before environment. */
  readonly priority: number
  readonly content: string
  /** Why this section must survive the budget, when it must. */
  readonly protectedBy?: readonly ProtectedContent[] | undefined
}

export interface SystemPromptAssemblerOptions {
  /** Prompt identity, e.g. `bee-system@1.0.0`; recorded on the manifest. */
  readonly promptVersion: string
  readonly structureVersion: string
  readonly sections:
    | readonly SystemPromptSectionInput[]
    | (() => readonly SystemPromptSectionInput[])
  /** Total budget for the assembled prompt; defaults to 2048 tokens. */
  readonly tokenBudget?: number | undefined
}

export interface AssembledSystemPrompt {
  /** The final system message text, sections joined in priority order. */
  readonly content: string
  /** What the budget decided, for audit and drift detection. */
  readonly manifest: ContextManifest
  /** Sections dropped by the budget, by id. */
  readonly omittedSectionIds: readonly string[]
}

export class SystemPromptAssembler {
  readonly #options: SystemPromptAssemblerOptions
  #resolved: AssembledSystemPrompt | undefined

  constructor(options: SystemPromptAssemblerOptions) {
    this.#options = options
  }

  /**
   * Assembles (once — memoized) and returns the prompt. Every call after
   * the first returns the identical object, so the loop can reuse one
   * system message across generations and keep the prefix byte-stable.
   */
  async resolve(): Promise<AssembledSystemPrompt> {
    if (this.#resolved !== undefined) return this.#resolved
    const inputs =
      typeof this.#options.sections === 'function'
        ? this.#options.sections()
        : this.#options.sections
    const tokenBudget =
      this.#options.tokenBudget ?? DEFAULT_SYSTEM_PROMPT_TOKEN_BUDGET

    const sections: readonly PromptSection[] = inputs.map((section) => ({
      id: section.id,
      kind: 'instruction',
      priority: section.priority,
      content: section.content,
      ...(section.protectedBy === undefined
        ? {}
        : { protectedBy: section.protectedBy }),
    }))
    const allocation = allocateContextBudget(sections, tokenBudget)

    const manifest = buildContextManifest({
      id: crypto.randomUUID(),
      promptVersion: this.#options.promptVersion,
      structureVersion: this.#options.structureVersion,
      tokenBudget,
      sections: allocation.sections.map((section) => ({
        kind: section.kind,
        sourceIds: [section.id],
        rendererVersion: 'system-prompt-text@1',
        priority: section.priority,
        content: section.content,
      })),
      omissions: allocation.omissions,
    })

    this.#resolved = {
      content: allocation.sections.map((s) => s.content).join('\n\n'),
      manifest,
      omittedSectionIds: allocation.omissions.map(
        (omission) => omission.sourceId,
      ),
    }
    return this.#resolved
  }
}
