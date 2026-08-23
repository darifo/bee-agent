import { z } from 'zod'

export const TaskStateSchema = z.enum([
  'pending',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
])
export type TaskState = z.infer<typeof TaskStateSchema>

export const TaskSpecSchema = z.object({
  id: z.uuid(),
  input: z.string().min(1),
  workspaceId: z.string().optional(),
  agentId: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
})
export type TaskSpec = z.infer<typeof TaskSpecSchema>

export const NewAgentEventSchema = z.object({
  taskId: z.uuid(),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
})
export type NewAgentEvent = z.infer<typeof NewAgentEventSchema>

export const AgentEventSchema = NewAgentEventSchema.extend({
  id: z.uuid(),
  sequence: z.number().int().positive(),
  createdAt: z.iso.datetime(),
})
export type AgentEvent = z.infer<typeof AgentEventSchema>

export const ToolManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
})
export type ToolManifest = z.infer<typeof ToolManifestSchema>

export const ToolCallSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  toolId: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
})
export type ToolCall = z.infer<typeof ToolCallSchema>

export const ToolResultSchema = z.object({
  callId: z.uuid(),
  output: z.unknown(),
  error: z.string().optional(),
})
export type ToolResult = z.infer<typeof ToolResultSchema>

export const ApprovalRequestSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  toolCall: ToolCallSchema,
  reason: z.string().min(1),
  risk: z.enum(['low', 'medium', 'high']),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().optional(),
})
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>

export const ApprovalDecisionSchema = z.object({
  requestId: z.uuid(),
  approved: z.boolean(),
  reason: z.string().optional(),
  decidedAt: z.iso.datetime(),
})
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>

export const CheckpointSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  sequence: z.number().int().nonnegative(),
  state: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
})
export type Checkpoint = z.infer<typeof CheckpointSchema>

export const HandoffSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  fromAgentId: z.string().min(1),
  toAgentId: z.string().min(1),
  context: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.iso.datetime(),
})
export type Handoff = z.infer<typeof HandoffSchema>

export const MemoryDocumentSchema = z.object({
  id: z.uuid(),
  workspaceId: z.string().min(1),
  content: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type MemoryDocument = z.infer<typeof MemoryDocumentSchema>

export const MemoryChunkSchema = z.object({
  id: z.uuid(),
  documentId: z.uuid(),
  workspaceId: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  content: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
})
export type MemoryChunk = z.infer<typeof MemoryChunkSchema>

export const EmbeddingSpaceSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  dimensions: z.number().int().positive(),
  metric: z.enum(['cosine', 'euclidean', 'inner_product']),
})
export type EmbeddingSpace = z.infer<typeof EmbeddingSpaceSchema>

export const EmbeddingRecordSchema = z.object({
  id: z.uuid(),
  chunkId: z.uuid(),
  workspaceId: z.string().min(1),
  embeddingSpaceId: z.string().min(1),
  vector: z.array(z.number()),
  metadata: z.record(z.string(), z.unknown()).default({}),
})
export type EmbeddingRecord = z.infer<typeof EmbeddingRecordSchema>

export const VectorSearchQuerySchema = z.object({
  workspaceId: z.string().min(1),
  embeddingSpace: EmbeddingSpaceSchema,
  vector: z.array(z.number()),
  limit: z.number().int().min(1).max(100).default(10),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type VectorSearchQuery = z.infer<typeof VectorSearchQuerySchema>

export const VectorSearchResultSchema = z.object({
  record: EmbeddingRecordSchema,
  score: z.number(),
})
export type VectorSearchResult = z.infer<typeof VectorSearchResultSchema>

export const ErrorEnvelopeSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
})
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>

export const CreateTaskRequestSchema = TaskSpecSchema.omit({ id: true })
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>

export const CreateTaskResponseSchema = z.object({
  task: TaskSpecSchema,
  state: TaskStateSchema,
})
export type CreateTaskResponse = z.infer<typeof CreateTaskResponseSchema>

export const SseEventEnvelopeSchema = z.object({
  id: z.string(),
  event: z.string(),
  data: z.unknown(),
})
export type SseEventEnvelope = z.infer<typeof SseEventEnvelopeSchema>
