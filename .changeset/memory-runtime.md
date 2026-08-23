---
'@bee-agent/contracts': minor
'@bee-agent/runtime': minor
'@bee-agent/server': minor
'@bee-agent/client': minor
'@bee-agent/cli': minor
---

Added the memory runtime: workspace-scoped semantic memory on the Vector Store (ADR 0012).

- `@bee-agent/runtime`: new `Embedder` contract plus a deterministic `MockEmbedder` (FNV-1a bag-of-tokens, L2-normalized, so cosine similarity tracks token overlap) that stands in for real model providers; word-boundary chunking (`chunkContent`/`chunkDocument`); `MemoryRuntime` with `remember` (chunk → embed → upsert), `recall` (embed query → vector search → rebuild chunks from record metadata), and `forget`. Chunk payloads ride on embedding-record metadata under a reserved `chunk` key alongside user metadata keys, so JSONB metadata filters keep working; each embedder owns its own embedding space, and switching embedders switches spaces instead of corrupting old vectors.
- `@bee-agent/contracts`: `CreateMemoryDocumentRequest`, `MemoryDocumentResponse`, `MemoryRecallRequest`, `MemoryRecallResult`, and `MemoryRecallResponse` schemas.
- `@bee-agent/server`: `POST /memory/documents`, `POST /memory/recall`, and `DELETE /memory/chunks/:chunkId?workspaceId=` — registered only when a Vector Store plugin is mounted (`vectorStore: 'pgvector'`), 404 otherwise; CORS now also allows DELETE.
- `@bee-agent/client`: `rememberDocument`, `recallMemory`, and `forgetMemoryChunk` SDK methods.
- `@bee-agent/cli`: `bee memory remember/recall/forget` commands.
