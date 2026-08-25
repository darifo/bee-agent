import type { EventStore } from '@bee-agent/event-store'
import type { BeeAgentPlugin } from '@bee-agent/plugin-sdk'
import manifestJson from '../plugin.manifest.json' with { type: 'json' }
import { PluginManifestSchema } from '@bee-agent/plugin-sdk'
import { PostgresEventStore } from './postgres-event-store.ts'
import { PostgresStorage } from './postgres-storage.ts'

export interface PostgresPluginConfig {
  /** Connection string, e.g. `postgres://user:pass@host:5432/database`. */
  readonly connectionString: string
}

export class PostgresStoragePlugin implements BeeAgentPlugin {
  readonly manifest = PluginManifestSchema.parse(manifestJson)
  readonly storage: PostgresStorage
  readonly eventStore: EventStore

  constructor(config: PostgresPluginConfig) {
    this.storage = new PostgresStorage(config.connectionString)
    this.eventStore = new PostgresEventStore(this.storage)
  }

  async start(): Promise<void> {
    await this.storage.migrate()
  }

  async stop(): Promise<void> {
    await this.storage.close()
  }
}
