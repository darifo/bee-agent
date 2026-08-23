import type { BeeAgentPlugin } from '@bee-agent/plugin-sdk'
import manifestJson from '../plugin.manifest.json' with { type: 'json' }
import { PluginManifestSchema } from '@bee-agent/plugin-sdk'
import { PgvectorStore } from './pgvector-store.js'

export interface PgvectorPluginConfig {
  /** Connection string, e.g. `postgres://user:pass@host:5432/database`. */
  readonly connectionString: string
}

export class PgvectorPlugin implements BeeAgentPlugin {
  readonly manifest = PluginManifestSchema.parse(manifestJson)
  readonly store: PgvectorStore

  constructor(config: PgvectorPluginConfig) {
    this.store = new PgvectorStore(config.connectionString)
  }

  async start(): Promise<void> {
    await this.store.migrate()
  }

  async stop(): Promise<void> {
    await this.store.close()
  }
}
