import type {
  EmbeddingRecord,
  VectorSearchQuery,
  VectorSearchResult,
} from '@bee-agent/contracts'

export interface VectorStore {
  upsert(record: EmbeddingRecord): Promise<void>
  search(query: VectorSearchQuery): Promise<VectorSearchResult[]>
  delete(id: string, workspaceId: string): Promise<void>
}
