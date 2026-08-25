export {
  ContextManifestSchema,
  ContextOmissionSchema,
  ContextReconstructionError,
  ContextSectionSchema,
  SECTION_KINDS,
  buildContextManifest,
  computeSectionDigest,
  estimateTokens,
  rebuildContextInput,
} from './context-manifest.ts'
export type {
  BuildContextManifestInput,
  ContextManifest,
  ContextOmission,
  ContextRenderer,
  ContextSection,
  ContextSectionDraft,
  RebuiltSection,
  SectionKind,
} from './context-manifest.ts'

export {
  CONTEXT_MANIFEST_EVENT_TYPE,
  ContextManifestPayloadSchema,
  appendContextManifest,
  contextManifestEvent,
  registerContextManifestChronicleEvents,
} from './manifest-events.ts'
export type { ContextManifestScope } from './manifest-events.ts'

export {
  PROTECTED_CONTENT,
  SECTION_PRIORITIES,
  allocateContextBudget,
  compileContextManifest,
  truncatingCompression,
} from './context-budget.ts'
export type {
  CompileContextInput,
  CompressionPolicy,
  ContextAllocation,
  PromptSection,
  ProtectedContent,
  SectionPriority,
} from './context-budget.ts'
