import type { BeeAgentPlugin } from '@bee-agent/plugin-sdk'
import { PluginManifestSchema } from '@bee-agent/plugin-sdk'
import type { Tool } from '@bee-agent/runtime'
import manifestJson from '../plugin.manifest.json' with { type: 'json' }
import { McpClient } from './mcp-client.ts'
import type { McpServerConfig, McpToolDescriptor } from './mcp-client.ts'

export class McpToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpToolError'
  }
}

/** Tool id namespace: `mcp.<server>.<tool>`, matching `tools.*` style. */
export function mcpToolId(serverName: string, toolName: string): string {
  return `mcp.${serverName}.${toolName}`
}

interface McpToolResult {
  readonly content?: readonly unknown[]
  readonly isError?: boolean
}

/**
 * One MCP tool behind the runtime's `Tool` contract. MCP `isError` results
 * become thrown errors, which the task runtime records as tool result
 * errors instead of failing the task.
 */
export class McpTool implements Tool {
  readonly manifest
  readonly serverName: string
  readonly #client: McpClient

  constructor(
    serverName: string,
    descriptor: McpToolDescriptor,
    client: McpClient,
  ) {
    this.serverName = serverName
    this.#client = client
    this.manifest = {
      id: mcpToolId(serverName, descriptor.name),
      name: descriptor.name,
      description:
        descriptor.description ??
        `MCP tool '${descriptor.name}' from '${serverName}'`,
      inputSchema: descriptor.inputSchema,
    }
  }

  async execute(input: Record<string, unknown>): Promise<unknown> {
    const result = (await this.#client.callTool(
      this.manifest.name,
      input,
    )) as McpToolResult
    const content = Array.isArray(result.content) ? result.content : []
    const texts = content
      .map((entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as { type?: unknown }).type === 'text'
          ? String((entry as { text?: unknown }).text)
          : undefined,
      )
      .filter((text): text is string => text !== undefined)

    if (result.isError === true) {
      throw new McpToolError(
        texts.join('\n') || 'MCP tool failed without a message',
      )
    }
    if (content.length === 1 && texts.length === 1) return texts[0]
    if (content.length === 0) return null
    return { content }
  }
}

/**
 * Lifecycle wrapper: starts one MCP server child process, discovers its
 * tools at mount time, and exposes them as runtime `Tool`s. Stopping the
 * kernel stops the child (the ADR 0007 isolation boundary).
 */
export class McpToolsPlugin implements BeeAgentPlugin {
  readonly manifest = PluginManifestSchema.parse(manifestJson)
  readonly config: McpServerConfig
  readonly #client: McpClient
  #tools: readonly Tool[] = []

  constructor(config: McpServerConfig) {
    this.config = config
    this.#client = new McpClient(config)
  }

  get tools(): readonly Tool[] {
    return this.#tools
  }

  async start(): Promise<void> {
    await this.#client.start()
    const descriptors = await this.#client.listTools()
    this.#tools = descriptors.map(
      (descriptor) => new McpTool(this.config.name, descriptor, this.#client),
    )
  }

  async stop(): Promise<void> {
    await this.#client.close()
  }
}
