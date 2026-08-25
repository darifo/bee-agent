/**
 * Bee kernel public surface.
 *
 * Cordis owns Context/Registry/Fiber and effect lifecycles. Bee adds immutable
 * StructureGeneration snapshots, Turn pinning, policy-scoped service access,
 * and deterministic structure resolution.
 */
export * from './cordis/index.ts'

export {
  BEE_PROFILE_ID,
  BundleSchema,
  BundleSourceSchema,
  BudgetValueSchema,
  EffectiveSlotSchema,
  EffectiveStructureSchema,
  StructureRefSchema,
  canonicalJson,
  computeStructureDigest,
  resolveEffectiveStructure,
  structureVersionOf,
  traceStructure,
} from './structure.ts'
export type {
  Bundle,
  BundleLoader,
  BundleSource,
  BudgetValue,
  EffectiveSlot,
  EffectiveStructure,
  ScalarSlotName,
  StructureProvenanceEntry,
  StructureRef,
  StructureVersion,
} from './structure.ts'

export { PluginManifestSchema } from './plugin.ts'
export type { PluginManifest } from './plugin.ts'

export {
  ContextScope,
  ContextPolicy,
  DuplicateServiceProviderError,
  GenerationLease,
  Kernel,
  MissingPluginDependencyError,
  NoActiveStructureGenerationError,
  PluginActivationError,
  PluginDependencyCycleError,
  REPLACEMENT_TIERS,
  RestrictedServiceAccessError,
  StructureVersionCollisionError,
  StructureGeneration,
  createKernel,
} from './kernel.ts'
export type {
  FiberSnapshot,
  FiberStatus,
  KernelLifecycleEvent,
  KernelOptions,
  PluginGraph,
  PluginHealth,
  ReconcileResult,
  ReplacementTier,
  RuntimePlugin,
  RuntimeGraphSnapshot,
  StructureGenerationState,
} from './kernel.ts'
