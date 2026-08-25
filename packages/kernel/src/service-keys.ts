import type { EventStore } from '@bee-agent/event-store'
import type { StorageProvider } from '@bee-agent/storage'
import type { VectorStore } from '@bee-agent/vector-store'
import { defineServiceKey } from './types.ts'

/**
 * Catalog of standard kernel service keys. Storage plugins publish their
 * implementations under these names so composition roots and runtime packages
 * can resolve infrastructure through one shared vocabulary.
 */
export const storageService = defineServiceKey<StorageProvider>('storage')

export const eventStoreService = defineServiceKey<EventStore>('event-store')

export const vectorStoreService = defineServiceKey<VectorStore>('vector-store')
