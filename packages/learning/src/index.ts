/**
 * Background learning (v1 refactor plan §5.6): the slow loop that turns
 * durable trajectories into governed ImprovementProposals. It runs apart
 * from the AgentLoop with its own budget, reads facts only, and writes
 * proposals only — experiments, trials, and rollback land with WF5-C..E.
 */
export {
  MAX_LOOP_AUTONOMY_LEVEL,
  OPEN_PROPOSAL_STATUSES,
  PROPOSAL_STATUSES,
  PROPOSAL_TRANSITIONS,
  PROPOSAL_TYPES,
  AutonomyLevelSchema,
  ImprovementProposalSchema,
  InvalidProposalTransitionError,
  ProposalNotFoundError,
  ProposalVersionConflictError,
  ProposalStatusSchema,
  ProposalTypeSchema,
  TrajectoryRefSchema,
  canTransitionProposal,
} from './proposal.ts'
export type {
  AutonomyLevel,
  ImprovementProposal,
  ProposalStatus,
  ProposalType,
  TrajectoryRef,
} from './proposal.ts'
export {
  LEARNING_EVENT_TYPES,
  LEARNING_STREAM_ID,
  learningLoopRunEvent,
  learningProposalCreatedEvent,
  learningProposalStatusChangedEvent,
  learningStreamId,
  registerLearningChronicleEvents,
  UnknownLearningEventTypeError,
} from './events.ts'
export type {
  LearningEventBuildOptions,
  LearningEventType,
  LearningRunReport,
} from './events.ts'
export { ChronicleProposalStore } from './store.ts'
export type { CreateProposalInput, ProposalQuery } from './store.ts'
export {
  DEFAULT_LEARNING_BUDGET,
  LearningLoop,
  discoverPatterns,
  selectAndDerive,
} from './loop.ts'
export type {
  DerivedTurn,
  LearningLoopBudget,
  LearningLoopOptions,
  ProposalCandidate,
} from './loop.ts'
export {
  EvidenceVerifyEvaluator,
  ExperimentWorld,
  ExperimentNotAllowedError,
  changesetDigestOf,
  freezeDataset,
} from './experiment.ts'
export type {
  Evaluator,
  EvaluatorInput,
  EvaluatorOutput,
  ExperimentReport,
  ExperimentVerdict,
  ExperimentWorldOptions,
  FrozenDataset,
  FrozenTrajectory,
  RollbackPackage,
} from './experiment.ts'
