/**
 * Bounded execution: the content-addressed ArtifactStore contract (Phase 1)
 * followed by the capability pipeline, permissions, approvals, secret
 * brokering, ExecutionWorld, and sandbox contracts (Phase 3).
 */
export {
  ArtifactNotFoundError,
  InvalidArtifactDigestError,
  LocalArtifactStore,
  isValidArtifactDigest,
} from './artifact-store.js'
export type { ArtifactRef, ArtifactStore } from './artifact-store.js'
