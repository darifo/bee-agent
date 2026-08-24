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
} from './envelope.js'
export type {
  ChronicleActor,
  ChronicleEvent,
  EventClassification,
  NewChronicleEvent,
  NewChronicleEventInput,
  ValidTime,
} from './envelope.js'
export {
  ChronicleEventValidationError,
  ChronicleSchemaRegistry,
  UnknownChronicleEventTypeError,
} from './registry.js'
export type {
  ChronicleTypeRegistration,
  ChronicleTypeRegistrationOptions,
  ReplayValidation,
} from './registry.js'
export {
  ChronicleSequenceConflictError,
  type ChronicleStore,
} from './chronicle-store.js'
export type { ChronicleAppendOptions } from './chronicle-store.js'
