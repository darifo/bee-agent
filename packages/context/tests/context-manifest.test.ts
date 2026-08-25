import { describe, expect, it } from 'vitest'
import {
  ContextReconstructionError,
  buildContextManifest,
  computeSectionDigest,
  estimateTokens,
  rebuildContextInput,
} from '../src/index.ts'
import type {
  ContextManifest,
  ContextRenderer,
  ContextSectionDraft,
} from '../src/index.ts'

const instructionContent = 'You are Bee, a personal agent.'
const toolContent = 'calculator(expression: string): number'

const instructionSource = 'prompt/bee-system@3'
const toolSource = 'tool/calculator@1'

function manifestFixture(): ContextManifest {
  return buildContextManifest({
    id: '0b6c6a68-8c5f-4d8f-9b52-1f2b1a2c3d4e',
    promptVersion: 'bee-system@3',
    structureVersion:
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    tokenBudget: 32000,
    sections: [
      {
        kind: 'instruction',
        sourceIds: [instructionSource],
        rendererVersion: 'identity@1',
        priority: 0,
        content: instructionContent,
      },
      {
        kind: 'tool',
        sourceIds: [toolSource],
        rendererVersion: 'identity@1',
        priority: 5,
        content: toolContent,
      },
    ],
  })
}

/** Renders a section by joining its sources' contents verbatim. */
function identityRenderer(): ContextRenderer {
  return {
    version: 'identity@1',
    render(sourceIds, sources) {
      return sourceIds.map((id) => sources.get(id) ?? '').join('\n')
    },
  }
}

function sources(): Map<string, string> {
  return new Map([
    [instructionSource, instructionContent],
    [toolSource, toolContent],
  ])
}

describe('buildContextManifest', () => {
  it('records sections with a deterministic digest and token estimate', () => {
    const manifest = manifestFixture()
    expect(manifest.sections).toHaveLength(2)
    expect(manifest.sections[0]?.kind).toBe('instruction')
    expect(manifest.sections[0]?.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(manifest.sections[0]?.tokens).toBe(
      estimateTokens(instructionContent),
    )
    expect(manifest.omissions).toEqual([])
  })

  it('records explicit omissions', () => {
    const manifest = buildContextManifest({
      id: '0b6c6a68-8c5f-4d8f-9b52-1f2b1a2c3d4e',
      promptVersion: 'bee-system@3',
      structureVersion:
        'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      tokenBudget: 32000,
      sections: [],
      omissions: [{ sourceId: 'memory/old-note', reason: 'stale' }],
    })
    expect(manifest.omissions).toEqual([
      { sourceId: 'memory/old-note', reason: 'stale' },
    ])
  })

  it('changes the digest when the rendered content changes', () => {
    const base = manifestFixture()
    const changed: ContextSectionDraft[] = [
      {
        kind: 'instruction',
        sourceIds: [instructionSource],
        rendererVersion: 'identity@1',
        priority: 0,
        content: `${instructionContent} (v2)`,
      },
    ]
    const other = buildContextManifest({
      id: base.id,
      promptVersion: base.promptVersion,
      structureVersion: base.structureVersion,
      tokenBudget: base.tokenBudget,
      sections: changed,
    })
    expect(other.sections[0]?.digest).not.toBe(base.sections[0]?.digest)
  })
})

describe('computeSectionDigest', () => {
  it('is order-insensitive to object key order via canonical json', () => {
    const a = computeSectionDigest({
      kind: 'instruction',
      sourceIds: ['s1'],
      rendererVersion: 'r1',
      content: 'hello',
    })
    const b = computeSectionDigest({
      content: 'hello',
      rendererVersion: 'r1',
      sourceIds: ['s1'],
      kind: 'instruction',
    })
    expect(b).toBe(a)
  })
})

describe('rebuildContextInput', () => {
  it('rebuilds sections in priority order and re-checks digests', () => {
    const manifest = manifestFixture()
    const rebuilt = rebuildContextInput(
      manifest,
      sources(),
      new Map([['identity@1', identityRenderer()]]),
    )
    expect(rebuilt.map((entry) => entry.section.kind)).toEqual([
      'instruction',
      'tool',
    ])
    expect(rebuilt[0]?.text).toBe(instructionContent)
    expect(rebuilt[1]?.text).toBe(toolContent)
  })

  it('rejects when a source changed since the manifest was recorded', () => {
    const manifest = manifestFixture()
    const tampered = sources()
    tampered.set(instructionSource, 'a different prompt')
    expect(() =>
      rebuildContextInput(
        manifest,
        tampered,
        new Map([['identity@1', identityRenderer()]]),
      ),
    ).toThrow(ContextReconstructionError)
  })

  it('rejects when the renderer version is missing', () => {
    const manifest = manifestFixture()
    expect(() => rebuildContextInput(manifest, sources(), new Map())).toThrow(
      /No renderer registered/,
    )
  })
})
