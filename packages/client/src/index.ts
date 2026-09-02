export { BeeAgentClient } from './client.ts'
export type {
  ApprovalDecision,
  BeeAgentClientOptions,
  CreateTaskInput,
  CreateThreadInput,
  CreateTurnInput,
  KanbanCommentDto,
  KanbanTaskDto,
  ListTasksQuery,
  StreamItemsOptions,
  TurnResult,
  UpdateTaskInput,
} from './client.ts'
export { BeeAgentClientError, BeeAgentProtocolError } from './errors.ts'
export { parseSseStream } from './sse.ts'
export type { SseFrame } from './sse.ts'
export type {
  Diagnostics,
  GrantDto,
  LearningProposalDto,
  LearningTransitionInput,
  MemoryClaimDto,
  ModelReplayDto,
  ThreadSummaryDto,
  TurnTrajectoryDto,
  TrajectoryCategory,
  TrajectoryEntryDto,
  TrajectoryLoop,
  TrajectoryPageDto,
  TrajectoryQuery,
} from './client.ts'
