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
  MemoryProviderUnavailableError,
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
  memoryHealthChangedEvent,
  memoryObservationRecordedEvent,
  registerMemoryChronicleEvents,
  UnknownMemoryEventTypeError,
} from './memory-events.ts'
export type {
  MemoryEventBuildOptions,
  MemoryEventType,
} from './memory-events.ts'
export {
  WORLD_ENTITY_KINDS,
  WORLD_RELATION_TYPES,
  WorldEntityKindSchema,
  WorldEntitySchema,
  WorldProvenanceSchema,
  WorldRelationSchema,
  WorldRelationTypeSchema,
  WorldVersionDriftError,
  WorldVersionSchema,
} from './world-schema.ts'
export type {
  NewWorldEntityInput,
  NewWorldRelationInput,
  WorldAttributeValue,
  WorldEntity,
  WorldEntityKind,
  WorldProjectionInput,
  WorldProvenance,
  WorldRelation,
  WorldRelationType,
  WorldSnapshot,
  WorldVersion,
} from './world-schema.ts'
export {
  BEE_ACTOR_ENTITY_ID,
  ThreadToolProjector,
  deterministicWorldId,
} from './world-projector.ts'
export type { WorldProjector } from './world-projector.ts'
export { WorldModelStore } from './world.ts'
export type { WorldModelStoreOptions } from './world.ts'
export {
  WORLD_EVENT_TYPES,
  WORLD_STREAM_ID,
  registerWorldChronicleEvents,
  UnknownWorldEventTypeError,
  worldEntityRecordedEvent,
  worldRelationProjectedEvent,
  worldStreamId,
  worldVersionBumpedEvent,
} from './world-events.ts'
export type { WorldEventBuildOptions, WorldEventType } from './world-events.ts'
