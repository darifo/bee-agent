import type { BeeAgentPlugin } from '@bee-agent/plugin-sdk'
import { PluginManifestSchema } from '@bee-agent/plugin-sdk'
import type { Tool } from '@bee-agent/runtime'
import manifestJson from '../plugin.manifest.json' with { type: 'json' }
import { CalculatorTool } from './tool.js'

/**
 * Calculator capability plugin. The composition root passes `plugin.tool`
 * into the task runtime's tool registry (or mounts it with a `tools`
 * service mapping), keeping the runtime independent of concrete plugins.
 */
export class CalculatorPlugin implements BeeAgentPlugin {
  readonly manifest = PluginManifestSchema.parse(manifestJson)
  readonly tool: Tool

  constructor(tool: CalculatorTool = new CalculatorTool()) {
    this.tool = tool
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}
}
