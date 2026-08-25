/**
 * Knowledge base: the Chronicle event envelope, event type registry, and the
 * ChronicleStore contract (v1 refactor plan §5.2 P1-5/P1-6). World/structure
 * projections and memory provider contracts join in Phase 4.
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
  STRUCTURE_RESOLVED_EVENT_TYPE,
  STRUCTURE_STREAM_ID,
  StructureResolvedPayloadSchema,
  appendResolvedStructure,
  registerStructureChronicleEvents,
  structureResolvedEvent,
} from './structure-events.ts'
export type {
  AppendResolvedStructureOptions,
  StructureResolvedPayload,
} from './structure-events.ts'
