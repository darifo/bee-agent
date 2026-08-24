import { createHash } from 'node:crypto'
import { z } from 'zod'

/**
 * The one and only root profile (architecture §14.2). Bundles compose
 * capabilities under it; the system offers no profile creation, switching,
 * inheritance, or multiple identities, and the bundle schema enforces that
 * by only ever accepting this literal.
 */
export const BEE_PROFILE_ID = 'bee'

/** A pinned reference to a structure node: an id plus an exact version. */
export const StructureRefSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
})
export type StructureRef = z.infer<typeof StructureRefSchema>

/** Which bundle contributed a node to the effective structure. */
export const BundleSourceSchema = z.object({
  bundleId: z.string().min(1),
  bundleVersion: z.string().min(1),
})
export type BundleSource = z.infer<typeof BundleSourceSchema>

export const BudgetValueSchema = z.union([z.string(), z.number(), z.boolean()])
export type BudgetValue = z.infer<typeof BudgetValueSchema>

/**
 * A bundle: a named, versioned set of structure references that may omit
 * any scalar slot (architecture §14.2). Bundles compose through `includes`:
 * includes fold first and the including bundle last, so the includer wins
 * conflicts and included bundles act as bases to layer onto. Resolution
 * fails loud when the folded chain leaves any scalar slot unpinned.
 */
export const BundleSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  profile: z.literal(BEE_PROFILE_ID).default(BEE_PROFILE_ID),
  model: StructureRefSchema.optional(),
  prompt: StructureRefSchema.optional(),
  contextPolicy: StructureRefSchema.optional(),
  memoryView: StructureRefSchema.optional(),
  sandbox: StructureRefSchema.optional(),
  evalPolicy: StructureRefSchema.optional(),
  skills: z.array(StructureRefSchema).default([]),
  tools: z.array(StructureRefSchema).default([]),
  permissions: z.array(z.string().min(1)).default([]),
  budgets: z.record(z.string().min(1), BudgetValueSchema).default({}),
  includes: z.array(StructureRefSchema).default([]),
})
export type Bundle = z.infer<typeof BundleSchema>

const SCALAR_SLOT_NAMES = [
  'model',
  'prompt',
  'contextPolicy',
  'memoryView',
  'sandbox',
  'evalPolicy',
] as const
export type ScalarSlotName = (typeof SCALAR_SLOT_NAMES)[number]

/** One resolved node of the effective structure with its provenance. */
export const EffectiveSlotSchema = z.object({
  ref: StructureRefSchema,
  source: BundleSourceSchema,
})
export type EffectiveSlot = z.infer<typeof EffectiveSlotSchema>

const StructureDigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'expected a sha256:<64 hex> digest')

/**
 * The immutable result of resolving a bundle chain (architecture §14.4):
 * every slot records which bundle version contributed it, and the digest is
 * computed over the canonical form of everything except the digest itself.
 */
export const EffectiveStructureSchema = z.object({
  profileId: z.literal(BEE_PROFILE_ID),
  /** Bundle chain in resolution order: includes first, the root bundle last. */
  bundles: z.array(BundleSourceSchema),
  model: EffectiveSlotSchema,
  prompt: EffectiveSlotSchema,
  contextPolicy: EffectiveSlotSchema,
  memoryView: EffectiveSlotSchema,
  sandbox: EffectiveSlotSchema,
  evalPolicy: EffectiveSlotSchema,
  skills: z.array(EffectiveSlotSchema),
  tools: z.array(EffectiveSlotSchema),
  permissions: z.array(
    z.object({ name: z.string().min(1), source: BundleSourceSchema }),
  ),
  budgets: z.array(
    z.object({
      name: z.string().min(1),
      value: BudgetValueSchema,
      source: BundleSourceSchema,
    }),
  ),
  digest: StructureDigestSchema,
})
export type EffectiveStructure = z.infer<typeof EffectiveStructureSchema>

/** What a Turn or Episode pins when it needs a reproducible structure. */
export interface StructureVersion {
  readonly profileId: typeof BEE_PROFILE_ID
  readonly digest: string
}

export function structureVersionOf(
  structure: EffectiveStructure,
): StructureVersion {
  return { profileId: structure.profileId, digest: structure.digest }
}

/**
 * Stable JSON: object keys sorted recursively, arrays order-preserving. The
 * digest input for {@link computeStructureDigest} and any other value that
 * must hash identically regardless of authoring order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) as string
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

/** Digest over the canonical form of a digest-less effective structure. */
export function computeStructureDigest(
  structure: Omit<EffectiveStructure, 'digest'>,
): string {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(structure))
    .digest('hex')}`
}

/** Loads an included bundle by its pinned reference. */
export type BundleLoader = (reference: StructureRef) => Bundle | Promise<Bundle>

function refKey(ref: StructureRef): string {
  return `${ref.id}@${ref.version}`
}

/**
 * Resolves a bundle and everything it includes into one immutable
 * {@link EffectiveStructure}. The chain folds includes-first and the given
 * bundle last, so the includer wins every conflict: scalar slots are
 * overridden, skills and tools merge by id with the later fold winning,
 * permissions form a union, and budgets override per key. Every scalar slot
 * must end up pinned by some bundle in the chain. Diamond includes resolve
 * once; include cycles and loader mismatches fail loud.
 */
export async function resolveEffectiveStructure(
  root: Bundle,
  load?: BundleLoader,
): Promise<EffectiveStructure> {
  const chain: Bundle[] = []
  const resolved = new Set<string>()
  const visiting = new Set<string>()

  const visit = async (bundle: Bundle): Promise<void> => {
    const key = refKey({ id: bundle.id, version: bundle.version })
    if (resolved.has(key)) return
    if (visiting.has(key)) {
      throw new Error(`Bundle include cycle detected at '${key}'`)
    }
    visiting.add(key)
    try {
      for (const reference of bundle.includes) {
        const includeKey = refKey(reference)
        if (resolved.has(includeKey)) continue
        if (load === undefined) {
          throw new Error(
            `Bundle '${key}' includes '${includeKey}' but no bundle loader was provided`,
          )
        }
        const loaded = BundleSchema.parse(await load(reference))
        const loadedKey = refKey({
          id: loaded.id,
          version: loaded.version,
        })
        if (loadedKey !== includeKey) {
          throw new Error(
            `Bundle loader returned '${loadedKey}' for include '${includeKey}'`,
          )
        }
        await visit(loaded)
      }
    } finally {
      visiting.delete(key)
    }
    resolved.add(key)
    chain.push(bundle)
  }

  await visit(BundleSchema.parse(root))

  const scalars = new Map<ScalarSlotName, EffectiveSlot>()
  const skills = new Map<string, EffectiveSlot>()
  const tools = new Map<string, EffectiveSlot>()
  const permissions = new Map<string, BundleSource>()
  const budgets = new Map<
    string,
    { name: string; value: BudgetValue; source: BundleSource }
  >()

  const mergeList = (
    target: Map<string, EffectiveSlot>,
    refs: readonly StructureRef[],
    source: BundleSource,
  ): void => {
    for (const ref of refs) {
      target.set(ref.id, { ref, source })
    }
  }

  for (const bundle of chain) {
    const source: BundleSource = {
      bundleId: bundle.id,
      bundleVersion: bundle.version,
    }
    for (const name of SCALAR_SLOT_NAMES) {
      const ref = bundle[name]
      if (ref !== undefined) scalars.set(name, { ref, source })
    }
    mergeList(skills, bundle.skills, source)
    mergeList(tools, bundle.tools, source)
    for (const name of bundle.permissions) {
      permissions.set(name, source)
    }
    for (const [name, value] of Object.entries(bundle.budgets)) {
      budgets.set(name, { name, value, source })
    }
  }

  const pick = (name: ScalarSlotName): EffectiveSlot => {
    const slot = scalars.get(name)
    if (slot === undefined) {
      throw new Error(
        `Scalar structure slot '${name}' was not resolved; no bundle in the chain pinned it`,
      )
    }
    return slot
  }

  const structure: Omit<EffectiveStructure, 'digest'> = {
    profileId: BEE_PROFILE_ID,
    bundles: chain.map((bundle) => ({
      bundleId: bundle.id,
      bundleVersion: bundle.version,
    })),
    model: pick('model'),
    prompt: pick('prompt'),
    contextPolicy: pick('contextPolicy'),
    memoryView: pick('memoryView'),
    sandbox: pick('sandbox'),
    evalPolicy: pick('evalPolicy'),
    skills: [...skills.values()],
    tools: [...tools.values()],
    permissions: [...permissions.entries()]
      .map(([name, source]) => ({ name, source }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    budgets: [...budgets.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    ),
  }

  return EffectiveStructureSchema.parse({
    ...structure,
    digest: computeStructureDigest(structure),
  })
}

export interface StructureProvenanceEntry {
  /** Slot kind: a scalar slot name, or `skill` / `tool` / `permission` / `budget`. */
  readonly kind: string
  readonly id: string
  readonly version: string | undefined
  readonly source: BundleSource
}

/**
 * Flattens the effective tree into provenance rows: every node with the
 * bundle id and version it came from. This is the "queryable sources" view
 * over a resolved structure.
 */
export function traceStructure(
  structure: EffectiveStructure,
): readonly StructureProvenanceEntry[] {
  const rows: StructureProvenanceEntry[] = []
  for (const name of SCALAR_SLOT_NAMES) {
    const slot = structure[name]
    rows.push({
      kind: name,
      id: slot.ref.id,
      version: slot.ref.version,
      source: slot.source,
    })
  }
  for (const [kind, list] of [
    ['skill', structure.skills],
    ['tool', structure.tools],
  ] as const) {
    for (const slot of list) {
      rows.push({
        kind,
        id: slot.ref.id,
        version: slot.ref.version,
        source: slot.source,
      })
    }
  }
  for (const permission of structure.permissions) {
    rows.push({
      kind: 'permission',
      id: permission.name,
      version: undefined,
      source: permission.source,
    })
  }
  for (const budget of structure.budgets) {
    rows.push({
      kind: 'budget',
      id: budget.name,
      version: undefined,
      source: budget.source,
    })
  }
  return rows
}
