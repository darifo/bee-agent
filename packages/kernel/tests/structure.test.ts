import { describe, expect, it } from 'vitest'
import {
  BEE_PROFILE_ID,
  BundleSchema,
  canonicalJson,
  computeStructureDigest,
  resolveEffectiveStructure,
  structureVersionOf,
  traceStructure,
} from '../src/index.js'
import type { Bundle, StructureRef } from '../src/index.js'

/** A complete base bundle: every scalar slot of the bee profile pinned. */
const baseBundle: Bundle = BundleSchema.parse({
  id: 'bee-core',
  version: '1.0.0',
  model: { id: 'openai', version: 'gpt-5.3' },
  prompt: { id: 'bee-system', version: '3' },
  contextPolicy: { id: 'default-context', version: '1' },
  memoryView: { id: 'personal', version: '2' },
  sandbox: { id: 'local-sandbox', version: '1' },
  evalPolicy: { id: 'default-eval', version: '1' },
  skills: [
    { id: 'web-search', version: '2' },
    { id: 'file-edit', version: '1' },
  ],
  tools: [{ id: 'calculator', version: '1' }],
  permissions: ['fs:read', 'net:fetch'],
  budgets: { turnTokens: 32000, wallClockSeconds: 600 },
})

function bundleRef(id: string, version: string): StructureRef {
  return { id, version }
}

function refKeyOf(ref: StructureRef): string {
  return `${ref.id}@${ref.version}`
}

describe('Bundle schema', () => {
  it('accepts a complete bundle and fills list defaults', () => {
    const parsed = BundleSchema.parse({
      id: 'complete',
      version: '0.0.1',
      model: { id: 'm', version: '1' },
      prompt: { id: 'p', version: '1' },
      contextPolicy: { id: 'c', version: '1' },
      memoryView: { id: 'mv', version: '1' },
      sandbox: { id: 's', version: '1' },
      evalPolicy: { id: 'e', version: '1' },
    })
    expect(parsed.profile).toBe(BEE_PROFILE_ID)
    expect(parsed.skills).toEqual([])
    expect(parsed.budgets).toEqual({})
    expect(parsed.includes).toEqual([])
  })

  it('accepts a thin shell bundle that only composes includes', () => {
    const parsed = BundleSchema.parse({
      id: 'bee',
      version: '1.0.0',
      includes: [bundleRef('bee-core', '1.0.0')],
    })
    expect(parsed.model).toBeUndefined()
    expect(parsed.includes).toHaveLength(1)
  })

  it('rejects any profile other than the single bee root', () => {
    expect(() =>
      BundleSchema.parse({ ...baseBundle, id: 'impostor', profile: 'coding' }),
    ).toThrow(/bee/)
  })
})

describe('resolveEffectiveStructure', () => {
  it('resolves a complete bundle with full provenance and a sha256 digest', async () => {
    const structure = await resolveEffectiveStructure(baseBundle)

    expect(structure.profileId).toBe(BEE_PROFILE_ID)
    expect(structure.bundles).toEqual([
      { bundleId: 'bee-core', bundleVersion: '1.0.0' },
    ])
    expect(structure.model).toEqual({
      ref: { id: 'openai', version: 'gpt-5.3' },
      source: { bundleId: 'bee-core', bundleVersion: '1.0.0' },
    })
    expect(structure.skills.map((slot) => slot.ref.id)).toEqual([
      'web-search',
      'file-edit',
    ])
    expect(structure.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(structureVersionOf(structure)).toEqual({
      profileId: BEE_PROFILE_ID,
      digest: structure.digest,
    })
  })

  it('fails loud when no bundle in the chain pins a scalar slot', async () => {
    const thin = BundleSchema.parse({
      id: 'thin',
      version: '1',
      prompt: { id: 'p', version: '1' },
    })
    await expect(resolveEffectiveStructure(thin)).rejects.toThrow(
      /Scalar structure slot 'model' was not resolved/,
    )
  })

  it('produces the same digest when the same bundle resolves twice', async () => {
    const first = await resolveEffectiveStructure(baseBundle)
    const second = await resolveEffectiveStructure(
      BundleSchema.parse(JSON.parse(JSON.stringify(baseBundle))),
    )
    expect(second.digest).toBe(first.digest)
  })

  it('is insensitive to permission and budget authoring order', async () => {
    const reordered = BundleSchema.parse({
      ...baseBundle,
      permissions: ['net:fetch', 'fs:read'],
      budgets: { wallClockSeconds: 600, turnTokens: 32000 },
    })
    const a = await resolveEffectiveStructure(baseBundle)
    const b = await resolveEffectiveStructure(reordered)
    expect(b.digest).toBe(a.digest)
  })

  it('changes the digest when a referenced version changes', async () => {
    const upgraded = BundleSchema.parse({
      ...baseBundle,
      model: { id: 'openai', version: 'gpt-5.4' },
    })
    const a = await resolveEffectiveStructure(baseBundle)
    const b = await resolveEffectiveStructure(upgraded)
    expect(b.digest).not.toBe(a.digest)
    expect(b.model.ref.version).toBe('gpt-5.4')
  })

  it('matches computeStructureDigest over the canonical form', async () => {
    const structure = await resolveEffectiveStructure(baseBundle)
    const withoutDigest = structuredClone(structure) as Partial<
      typeof structure
    >
    delete withoutDigest.digest
    expect(structure.digest).toBe(
      computeStructureDigest(withoutDigest as Omit<typeof structure, 'digest'>),
    )
    expect(canonicalJson({ b: 1, a: [2, { d: true, c: null }] })).toBe(
      '{"a":[2,{"c":null,"d":true}],"b":1}',
    )
  })

  it('folds base, overlay, and root so the includer wins conflicts', async () => {
    const beeBase: Bundle = BundleSchema.parse({
      id: 'bee-base',
      version: '0.9.0',
      prompt: { id: 'bee-system', version: '1' },
      contextPolicy: { id: 'default-context', version: '1' },
      memoryView: { id: 'personal', version: '2' },
      sandbox: { id: 'local-sandbox', version: '1' },
      evalPolicy: { id: 'default-eval', version: '1' },
      skills: [{ id: 'file-edit', version: '1' }],
      tools: [{ id: 'calculator', version: '1' }],
      permissions: ['fs:read'],
      includes: [],
    })
    const beeCoding: Bundle = BundleSchema.parse({
      id: 'bee-coding',
      version: '0.4.0',
      model: { id: 'local-lab', version: '4' },
      prompt: { id: 'bee-system', version: '2' },
      skills: [
        { id: 'web-search', version: '3' },
        { id: 'test-runner', version: '1' },
      ],
      permissions: ['fs:write'],
      budgets: { turnTokens: 64000 },
      includes: [bundleRef('bee-base', '0.9.0')],
    })
    // The user-facing root is a thin shell plus one authoritative pin.
    const root: Bundle = BundleSchema.parse({
      id: 'bee',
      version: '1.0.0',
      evalPolicy: { id: 'strict-eval', version: '9' },
      includes: [bundleRef('bee-coding', '0.4.0')],
    })
    const loaded = new Map<string, Bundle>([
      [refKeyOf({ id: 'bee-coding', version: '0.4.0' }), beeCoding],
      [refKeyOf({ id: 'bee-base', version: '0.9.0' }), beeBase],
    ])

    const structure = await resolveEffectiveStructure(root, (ref) => {
      const bundle = loaded.get(refKeyOf(ref))
      if (bundle === undefined)
        throw new Error(`no bundle for ${refKeyOf(ref)}`)
      return bundle
    })

    // Chain order: deepest include first, the given root last.
    expect(structure.bundles).toEqual([
      { bundleId: 'bee-base', bundleVersion: '0.9.0' },
      { bundleId: 'bee-coding', bundleVersion: '0.4.0' },
      { bundleId: 'bee', bundleVersion: '1.0.0' },
    ])
    // The overlay overrides the base; the root overrides the overlay.
    expect(structure.model.source).toEqual({
      bundleId: 'bee-coding',
      bundleVersion: '0.4.0',
    })
    expect(structure.prompt.ref.version).toBe('2')
    expect(structure.prompt.source.bundleId).toBe('bee-coding')
    expect(structure.evalPolicy.ref).toEqual({
      id: 'strict-eval',
      version: '9',
    })
    expect(structure.evalPolicy.source.bundleId).toBe('bee')
    // Slots the overlay never touched come from the base.
    expect(structure.tools[0]?.source.bundleId).toBe('bee-base')
    // Skills merge by id: the later fold wins the version, and the position
    // stays where the id first appeared (file-edit comes from the base).
    expect(
      structure.skills.map((slot) => [slot.ref.id, slot.ref.version]),
    ).toEqual([
      ['file-edit', '1'],
      ['web-search', '3'],
      ['test-runner', '1'],
    ])
    // Permissions union, budgets override per key.
    expect(structure.permissions.map((entry) => entry.name)).toEqual([
      'fs:read',
      'fs:write',
    ])
    expect(structure.budgets).toEqual([
      {
        name: 'turnTokens',
        value: 64000,
        source: { bundleId: 'bee-coding', bundleVersion: '0.4.0' },
      },
    ])
  })

  it('resolves diamond includes exactly once', async () => {
    const shared: Bundle = BundleSchema.parse({
      id: 'shared',
      version: '1',
      permissions: ['fs:read'],
    })
    const left: Bundle = BundleSchema.parse({
      id: 'left',
      version: '1',
      includes: [bundleRef('shared', '1')],
    })
    const right: Bundle = BundleSchema.parse({
      id: 'right',
      version: '1',
      includes: [bundleRef('shared', '1')],
    })
    const loadCounts = new Map<string, number>()
    const root: Bundle = BundleSchema.parse({
      ...baseBundle,
      includes: [bundleRef('left', '1'), bundleRef('right', '1')],
    })
    const structure = await resolveEffectiveStructure(root, (ref) => {
      const key = refKeyOf(ref)
      loadCounts.set(key, (loadCounts.get(key) ?? 0) + 1)
      if (key === 'shared@1') return shared
      if (key === 'left@1') return left
      if (key === 'right@1') return right
      throw new Error(`unexpected ${key}`)
    })

    expect(loadCounts.get('shared@1')).toBe(1)
    expect(structure.bundles).toEqual([
      { bundleId: 'shared', bundleVersion: '1' },
      { bundleId: 'left', bundleVersion: '1' },
      { bundleId: 'right', bundleVersion: '1' },
      { bundleId: 'bee-core', bundleVersion: '1.0.0' },
    ])
  })

  it('fails loud on include cycles', async () => {
    const a: Bundle = BundleSchema.parse({
      id: 'a',
      version: '1',
      includes: [bundleRef('b', '1')],
    })
    const b: Bundle = BundleSchema.parse({
      id: 'b',
      version: '1',
      includes: [bundleRef('a', '1')],
    })
    await expect(
      resolveEffectiveStructure(a, (ref) =>
        ref.id === 'a' ? a : ref.id === 'b' ? b : notFound(ref),
      ),
    ).rejects.toThrow(/cycle detected at 'a@1'/)
  })

  it('fails loud when includes exist but no loader was provided', async () => {
    const root = BundleSchema.parse({
      ...baseBundle,
      includes: [bundleRef('missing', '1')],
    })
    await expect(resolveEffectiveStructure(root)).rejects.toThrow(
      /no bundle loader was provided/,
    )
  })

  it('fails loud when the loader returns a different bundle than requested', async () => {
    const root = BundleSchema.parse({
      ...baseBundle,
      includes: [bundleRef('wanted', '1')],
    })
    const impostor = BundleSchema.parse({ id: 'returned', version: '9' })
    await expect(
      resolveEffectiveStructure(root, () => impostor),
    ).rejects.toThrow(/loader returned 'returned@9' for include 'wanted@1'/)
  })
})

describe('traceStructure', () => {
  it('lists every effective node with the bundle it came from', async () => {
    const structure = await resolveEffectiveStructure(baseBundle)
    const rows = traceStructure(structure)

    const model = rows.find((row) => row.kind === 'model')
    expect(model).toEqual({
      kind: 'model',
      id: 'openai',
      version: 'gpt-5.3',
      source: { bundleId: 'bee-core', bundleVersion: '1.0.0' },
    })
    expect(rows.filter((row) => row.kind === 'skill')).toHaveLength(2)
    expect(rows.filter((row) => row.kind === 'permission')).toHaveLength(2)
    expect(rows.filter((row) => row.kind === 'budget')).toHaveLength(2)
    expect(rows.every((row) => row.source.bundleId.length > 0)).toBe(true)
  })
})

function notFound(ref: StructureRef): Bundle {
  throw new Error(`unexpected ${refKeyOf(ref)}`)
}
