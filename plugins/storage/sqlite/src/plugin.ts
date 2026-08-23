import type { EventStore } from '@bee-agent/event-store'
import type { BeeAgentPlugin } from '@bee-agent/plugin-sdk'
import manifestJson from '../plugin.manifest.json' with { type: 'json' }
import { PluginManifestSchema } from '@bee-agent/plugin-sdk'
import { SQLiteEventStore } from './sqlite-event-store.js'
import { SQLiteStorage } from './sqlite-storage.js'

export interface SQLitePluginConfig {
  filename: string
}

export class SQLiteStoragePlugin implements BeeAgentPlugin {
  readonly manifest = PluginManifestSchema.parse(manifestJson)
  readonly storage: SQLiteStorage
  readonly eventStore: EventStore

  constructor(config: SQLitePluginConfig) {
    this.storage = new SQLiteStorage(config.filename)
    this.eventStore = new SQLiteEventStore(this.storage)
  }

  async start(): Promise<void> {
    await this.storage.migrate()
  }

  async stop(): Promise<void> {
    await this.storage.close()
  }
}
