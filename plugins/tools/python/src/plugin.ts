import type { BeeAgentPlugin } from '@bee-agent/plugin-sdk'
import { PluginManifestSchema } from '@bee-agent/plugin-sdk'
import type { Tool } from '@bee-agent/runtime'
import manifestJson from '../plugin.manifest.json' with { type: 'json' }
import { PythonTool } from './python-tool.js'
import type { PythonToolOptions } from './python-tool.js'

/**
 * Python capability plugin. Composition roots opt in: the tool runs
 * arbitrary code in child processes, so it is never registered by
 * default (ADR 0015).
 */
export class PythonPlugin implements BeeAgentPlugin {
  readonly manifest = PluginManifestSchema.parse(manifestJson)
  readonly tool: Tool

  constructor(options: PythonToolOptions = {}) {
    this.tool = new PythonTool(options)
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}
}
