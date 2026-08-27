/**
 * Knowledge base: the Chronicle event envelope, event type registry, the
 * ChronicleStore contract (v1 refactor plan §5.2 P1-5/P1-6), and the
 * Phase 4 memory domain/provider contract (§5.5 WF4-A).
 */
export {
  ChronicleActorSchema,
  ChronicleEventSchema,
  ChronicleScopeSchema,
  EventClassificationSchema,
  NewChronicleEventSchema,
  ValidTimeSchema,
  newChronicleEvent,
} from './envelope.ts'
export type {
  ChronicleActor,
  ChronicleEvent,
  EventClassification,
  NewChronicleEvent,
  NewChronicleEventInput,
  ValidTime,
} from './envelope.ts'
export {
  ChronicleEventValidationError,
  ChronicleSchemaRegistry,
  UnknownChronicleEventTypeError,
} from './registry.ts'
export type {
  ChronicleTypeRegistration,
  ChronicleTypeRegistrationOptions,
  ReplayValidation,
} from './registry.ts'
export {
  ChronicleSequenceConflictError,
  type ChronicleStore,
} from './chronicle-store.ts'
export type { ChronicleAppendOptions } from './chronicle-store.ts'
export {
  STRUCTURE_ACTIVATED_EVENT_TYPE,
  STRUCTURE_ACTIVATION_FAILED_EVENT_TYPE,
  STRUCTURE_UPDATED_EVENT_TYPE,
  STRUCTURE_DISPOSED_EVENT_TYPE,
  STRUCTURE_DRAINING_EVENT_TYPE,
  STRUCTURE_PREPARED_EVENT_TYPE,
  STRUCTURE_RESOLVED_EVENT_TYPE,
  STRUCTURE_RESTART_REQUIRED_EVENT_TYPE,
  STRUCTURE_STREAM_ID,
  StructureActivationFailedPayloadSchema,
  StructureLifecyclePayloadSchema,
  StructureResolvedPayloadSchema,
  StructureRestartRequiredPayloadSchema,
  appendResolvedStructure,
  appendStructureLifecycleEvent,
  readActiveStructure,
  registerStructureChronicleEvents,
  structureLifecycleEvent,
  structureResolvedEvent,
} from './structure-events.ts'
export type {
  AppendResolvedStructureOptions,
  StructureActivationFailedPayload,
  StructureLifecyclePayload,
  StructureResolvedPayload,
  StructureRestartRequiredPayload,
} from './structure-events.ts'
export {
  MEMORY_CLAIM_KINDS,
  MEMORY_CLAIM_STATUSES,
  MEMORY_RENDERER_VERSION,
  MemoryClaimKindSchema,
  MemoryClaimSchema,
  MemoryClaimStatusSchema,
  MemoryHealthSchema,
  MemoryObservationSchema,
  MemoryRepresentationSchema,
  MemorySubjectSchema,
  MemoryProvenanceSchema,
  MemoryClaimNotFoundError,
  estimateMemoryTokens,
} from './memory.ts'
export type {
  MemoryClaim,
  MemoryClaimKind,
  MemoryClaimStatus,
  MemoryContext,
  MemoryContextInput,
  MemoryDerivationInput,
  MemoryDerivationMessage,
  MemoryDerivationResult,
  MemoryExport,
  MemoryHealth,
  MemoryIngestInput,
  MemoryIngestResult,
  MemoryConsolidationReport,
  MemoryObservation,
  MemoryProvider,
  MemoryProvenance,
  MemoryQuery,
  MemoryRepresentation,
  MemorySubject,
  NewMemoryClaimInput,
  NewMemoryObservationInput,
} from './memory.ts'
export {
  MEMORY_EVENT_TYPES,
  MEMORY_STREAM_ID,
  memoryStreamId,
  memoryClaimRecordedEvent,
  memoryClaimRetractedEvent,
  memoryClaimSupersededEvent,
  memoryConsolidationCompletedEvent,
  memoryObservationRecordedEvent,
  registerMemoryChronicleEvents,
  UnknownMemoryEventTypeError,
} from './memory-events.ts'
export type {
  MemoryEventBuildOptions,
  MemoryEventType,
} from './memory-events.ts'
