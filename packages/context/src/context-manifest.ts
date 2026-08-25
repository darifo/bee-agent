import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJson } from '@bee-agent/kernel'

/**
 * The Context Manifest (architecture §10.3, v1 refactor plan §5.2 P1-12):
 * every model call persists one manifest instead of the full prompt. Each
 * section records where its content came from (`sourceIds`), which renderer
 * produced it (`rendererVersion`), its priority, token cost, and a content
 * digest — so a historical call's input can be rebuilt from source +
 * renderer and any drift (compression loss, source change) is auditable.
 */

export const SECTION_KINDS = [
  'instruction',
  'goal',
  'world',
  'trajectory',
  'memory',
  'skill',
  'tool',
] as const
export type SectionKind = (typeof SECTION_KINDS)[number]

const SectionKindSchema = z.enum(SECTION_KINDS)
const Sha256DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'expected a sha256:<64 hex> digest')

export const ContextSectionSchema = z.object({
  kind: SectionKindSchema,
  sourceIds: z.array(z.string().min(1)),
  rendererVersion: z.string().min(1),
  priority: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  digest: Sha256DigestSchema,
})
export type ContextSection = z.infer<typeof ContextSectionSchema>

export const ContextOmissionSchema = z.object({
  sourceId: z.string().min(1),
  reason: z.string().min(1),
})
export type ContextOmission = z.infer<typeof ContextOmissionSchema>

export const ContextManifestSchema = z.object({
  id: z.uuid(),
  promptVersion: z.string().min(1),
  structureVersion: z.string().min(1),
  tokenBudget: z.number().int().nonnegative(),
  sections: z.array(ContextSectionSchema),
  omissions: z.array(ContextOmissionSchema),
})
export type ContextManifest = z.infer<typeof ContextManifestSchema>

/**
 * Minimal token estimate: characters over four is a deterministic, cheap
 * stand-in for a real tokenizer. Phase 2 swaps this for model-specific
 * token counts without changing the manifest shape.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** A section before its digest is computed: it carries the rendered text. */
export interface ContextSectionDraft {
  readonly kind: SectionKind
  readonly sourceIds: readonly string[]
  readonly rendererVersion: string
  readonly priority: number
  readonly content: string
}

export interface BuildContextManifestInput {
  readonly id: string
  readonly promptVersion: string
  readonly structureVersion: string
  readonly tokenBudget: number
  readonly sections: readonly ContextSectionDraft[]
  readonly omissions?: readonly ContextOmission[] | undefined
}

/**
 * Digest over everything that determines a section's rendered text: the
 * kind, source ids, renderer version, and the content itself. Rebuilding the
 * same content from the same sources/renderer reproduces the digest; any
 * change to those inputs changes it.
 */
export function computeSectionDigest(
  section: Pick<
    ContextSectionDraft,
    'kind' | 'sourceIds' | 'rendererVersion' | 'content'
  >,
): string {
  return `sha256:${createHash('sha256')
    .update(
      canonicalJson({
        kind: section.kind,
        sourceIds: section.sourceIds,
        rendererVersion: section.rendererVersion,
        content: section.content,
      }),
    )
    .digest('hex')}`
}

export function buildContextManifest(
  input: BuildContextManifestInput,
): ContextManifest {
  return ContextManifestSchema.parse({
    id: input.id,
    promptVersion: input.promptVersion,
    structureVersion: input.structureVersion,
    tokenBudget: input.tokenBudget,
    sections: input.sections.map((section) => ({
      kind: section.kind,
      sourceIds: [...section.sourceIds],
      rendererVersion: section.rendererVersion,
      priority: section.priority,
      tokens: estimateTokens(section.content),
      digest: computeSectionDigest(section),
    })),
    omissions: input.omissions ?? [],
  })
}

/** Thrown when a rebuilt section's digest does not match the manifest. */
export class ContextReconstructionError extends Error {
  constructor(
    readonly section: ContextSection,
    readonly rebuiltDigest: string,
  ) {
    super(
      `Section '${section.kind}' rebuilt to digest ${rebuiltDigest}, expected ${section.digest}`,
    )
    this.name = 'ContextReconstructionError'
  }
}

export interface ContextRenderer {
  readonly version: string
  render(
    sourceIds: readonly string[],
    sources: ReadonlyMap<string, string>,
  ): string
}

export interface RebuiltSection {
  readonly section: ContextSection
  readonly text: string
}

/**
 * Rebuilds a call's model input from the manifest: every section is rendered
 * by the renderer matching its `rendererVersion` over its source contents,
 * then the digest is re-checked. Sections come back in priority order so the
 * output matches the budgeted assembly order.
 */
export function rebuildContextInput(
  manifest: ContextManifest,
  sources: ReadonlyMap<string, string>,
  renderers: ReadonlyMap<string, ContextRenderer>,
): readonly RebuiltSection[] {
  return [...manifest.sections]
    .sort((a, b) => a.priority - b.priority)
    .map((section) => {
      const renderer = renderers.get(section.rendererVersion)
      if (renderer === undefined) {
        throw new Error(
          `No renderer registered for version '${section.rendererVersion}'`,
        )
      }
      const text = renderer.render(section.sourceIds, sources)
      const rebuilt = computeSectionDigest({
        kind: section.kind,
        sourceIds: section.sourceIds,
        rendererVersion: section.rendererVersion,
        content: text,
      })
      if (rebuilt !== section.digest) {
        throw new ContextReconstructionError(section, rebuilt)
      }
      return { section, text }
    })
}
