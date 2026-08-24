import { describe, expect, it } from 'vitest'
import { ChronicleSchemaRegistry } from '../src/index.js'
import {
  MemoryChronicleStore,
  defineChronicleStoreContractSuite,
} from '../src/testing.js'
import type { ChronicleContractSubject } from '../src/testing.js'

const setup = {
  name: 'MemoryChronicleStore (Chronicle contract suite)',
  async create(): Promise<ChronicleContractSubject> {
    const registry = new ChronicleSchemaRegistry()
    const store = new MemoryChronicleStore(registry)
    return { store, registry }
  },
  destroy(subject: ChronicleContractSubject): Promise<void> {
    return subject.store.close()
  },
}

defineChronicleStoreContractSuite({ describe, it, expect }, setup)
