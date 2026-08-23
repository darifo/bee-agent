import { randomUUID } from 'node:crypto'
import type { MemoryChunk, MemoryDocument } from '@bee-agent/contracts'

/**
 * Splits content into chunks of at most `chunkSize` characters, breaking on
 * whitespace so words stay intact; a single longer word becomes its own
 * oversized chunk. Every chunk is non-empty.
 */
export function chunkContent(content: string, chunkSize: number): string[] {
  if (chunkSize < 1) throw new Error('chunkSize must be positive')
  const words = content.split(/\s+/).filter((word) => word.length > 0)
  const chunks: string[] = []
  let current = ''
  for (const word of words) {
    if (current.length === 0) {
      current = word
    } else if (current.length + 1 + word.length <= chunkSize) {
      current = `${current} ${word}`
    } else {
      chunks.push(current)
      current = word
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

export function chunkDocument(
  document: MemoryDocument,
  chunkSize: number,
): readonly MemoryChunk[] {
  return chunkContent(document.content, chunkSize).map((content, ordinal) => ({
    id: randomUUID(),
    documentId: document.id,
    workspaceId: document.workspaceId,
    ordinal,
    content,
    metadata: {},
  }))
}
