/**
 * Bee kernel public surface.
 *
 * Cordis owns Context/Registry/Fiber and effect lifecycles. Bee adds versioned
 * StructureGeneration snapshots, Turn pinning, policy-scoped service access,
 * trusted plugin selection, and deterministic structure resolution.
 */
export * from './cordis/index.ts'

export {
  BEE_PROFILE_ID,
  BundleSchema,
  BundlePluginSchema,
  BundleSourceSchema,
  BudgetValueSchema,
  EffectiveSlotSchema,
  EffectiveStructureSchema,
  EffectivePluginSchema,
  StructureRefSchema,
  canonicalJson,
  computeStructureDigest,
  resolveEffectiveStructure,
  structureVersionOf,
  traceStructure,
  verifyEffectiveStructure,
} from './structure.ts'
export type {
  Bundle,
  BundlePlugin,
  BundleLoader,
  BundleSource,
  BudgetValue,
  EffectiveSlot,
  EffectiveStructure,
  EffectivePlugin,
  ScalarSlotName,
  StructureProvenanceEntry,
  StructureRef,
  StructureVersion,
} from './structure.ts'

export { PluginManifestSchema } from './plugin.ts'
export type { PluginManifest } from './plugin.ts'

export {
  BEE_PLUGIN_API_VERSION,
  PluginApiVersionError,
  PluginCatalog,
  PluginNotInstalledError,
} from './plugin-catalog.ts'
export type {
  CatalogPluginFactory,
  PluginCatalogRegistration,
} from './plugin-catalog.ts'

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
  createReconcilePlan,
  createKernel,
} from './kernel.ts'
export type {
  FiberSnapshot,
  FiberStatus,
  KernelLifecycleEvent,
  KernelDoctorIssue,
  KernelDoctorReport,
  KernelOptions,
  PluginGraph,
  PluginChange,
  PluginHealth,
  QuarantineSnapshot,
  ReconcileResult,
  ReconcilePlan,
  ReplacementTier,
  RuntimePlugin,
  RuntimeGraphSnapshot,
  StructureGenerationState,
} from './kernel.ts'
