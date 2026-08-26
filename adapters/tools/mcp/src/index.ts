import { z } from 'zod'
import {
  canonicalExistingPath,
  canonicalNativeExecutable,
  canonicalWorkspaceRoot,
  resolveWorkspacePath,
} from '@bee-agent/runtime'
import type {
  ActionResult,
  LlmToolCall,
  LlmToolSpec,
  ToolAdapter,
  ToolAuthorizationRule,
} from '@bee-agent/runtime'

const McpNameSchema = z.string().regex(/^[A-Za-z0-9_-]+$/)
const McpToolManifestSchema = z.object({
  name: McpNameSchema,
  description: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()),
})
export type McpToolManifest = z.infer<typeof McpToolManifestSchema>

export const McpServerManifestSchema = z.object({
  name: McpNameSchema,
  protocolVersion: z.string().min(1),
  executable: z.string().min(1),
  arguments: z.array(z.string()).max(256).default([]),
  workspaceRoot: z.string().min(1),
  runtimeReadPaths: z.array(z.string().min(1)).default([]),
  readPaths: z.array(z.string().min(1)).max(128).default([]),
  writePaths: z.array(z.string().min(1)).max(128).default([]),
  secretEnv: z.record(z.string(), z.string()).default({}),
  maxInputBytes: z.number().int().positive().default(1_048_576),
  maxTimeoutMs: z.number().int().positive().default(30_000),
  maxOutputBytes: z.number().int().positive().default(1_048_576),
  tools: z.array(McpToolManifestSchema).min(1),
})
export type McpServerManifest = z.infer<typeof McpServerManifestSchema>

const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
})

function toolId(server: string, tool: string): string {
  return `mcp__${server}__${tool}`
}

function responseContent(result: unknown): {
  content: string
  isError: boolean
} {
  const parsed = z
    .object({
      content: z.array(z.record(z.string(), z.unknown())).default([]),
      isError: z.boolean().default(false),
    })
    .passthrough()
    .safeParse(result)
  if (!parsed.success) {
    return { content: JSON.stringify(result) ?? 'null', isError: false }
  }
  const content = parsed.data.content
    .map((item) =>
      item.type === 'text' && typeof item.text === 'string'
        ? item.text
        : JSON.stringify(item),
    )
    .join('\n')
  return {
    content: content === '' ? JSON.stringify(parsed.data) : content,
    isError: parsed.data.isError,
  }
}

/** One manifest-pinned MCP tool backed by a sandboxed one-shot stdio session. */
class McpToolAdapter implements ToolAdapter {
  readonly #server: McpServerManifest
  readonly #manifest: McpToolManifest
  readonly #executable: string
  readonly #workspaceRoot: string
  readonly #readPaths: readonly string[]
  readonly #writePaths: readonly string[]
  readonly #runtimeReadPaths: readonly string[]
  readonly spec: LlmToolSpec
  readonly authorization: ToolAuthorizationRule

  constructor(server: McpServerManifest, manifest: McpToolManifest) {
    this.#server = server
    this.#manifest = manifest
    this.#workspaceRoot = canonicalWorkspaceRoot(
      server.workspaceRoot,
      `MCP server '${server.name}' workspaceRoot`,
    )
    this.#executable = canonicalNativeExecutable(
      server.executable,
      `MCP server '${server.name}' executable`,
    )
    this.#runtimeReadPaths = server.runtimeReadPaths.map((path) =>
      canonicalExistingPath(
        path,
        `MCP server '${server.name}' runtimeReadPath`,
      ),
    )
    this.#readPaths = server.readPaths.map((path) =>
      resolveWorkspacePath(
        this.#workspaceRoot,
        path,
        `MCP server '${server.name}' readPath`,
      ),
    )
    this.#writePaths = server.writePaths.map((path) =>
      resolveWorkspacePath(
        this.#workspaceRoot,
        path,
        `MCP server '${server.name}' writePath`,
      ),
    )
    for (const [name, ref] of Object.entries(server.secretEnv)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || ref === '') {
        throw new Error(
          `MCP server '${server.name}' has an invalid secret binding`,
        )
      }
    }
    this.spec = {
      id: toolId(server.name, manifest.name),
      description: manifest.description,
      inputSchema: manifest.inputSchema,
    }
    this.authorization = {
      toolId: this.spec.id,
      decision: 'ask',
      reason: `MCP server '${server.name}' may perform declared external effects`,
    }
  }

  describe(call: LlmToolCall) {
    if (call.toolId !== this.spec.id) {
      throw new Error(`MCP adapter cannot describe tool '${call.toolId}'`)
    }
    const initializeId = `${call.callId}:initialize`
    const invocationId = `${call.callId}:call`
    const messages = {
      initialize: {
        jsonrpc: '2.0',
        id: initializeId,
        method: 'initialize',
        params: {
          protocolVersion: this.#server.protocolVersion,
          capabilities: {},
          clientInfo: { name: 'bee-agent', version: '1.0.0' },
        },
      },
      initialized: { jsonrpc: '2.0', method: 'notifications/initialized' },
      call: {
        jsonrpc: '2.0',
        id: invocationId,
        method: 'tools/call',
        params: { name: this.#manifest.name, arguments: call.input },
      },
    }
    const commandStdio = {
      kind: 'json-lines' as const,
      steps: [
        {
          input: `${JSON.stringify(messages.initialize)}\n`,
          waitFor: {
            kind: 'json-line-property' as const,
            property: 'id',
            equals: initializeId,
          },
        },
        { input: `${JSON.stringify(messages.initialized)}\n` },
        {
          input: `${JSON.stringify(messages.call)}\n`,
          waitFor: {
            kind: 'json-line-property' as const,
            property: 'id',
            equals: invocationId,
          },
        },
      ],
    }
    const inputBytes = commandStdio.steps.reduce(
      (size, step) => size + Buffer.byteLength(step.input),
      0,
    )
    if (inputBytes > this.#server.maxInputBytes) {
      throw new Error(`MCP request exceeds ${this.#server.maxInputBytes} bytes`)
    }
    return {
      capability: `tool:${this.spec.id}`,
      requirements: {
        readPaths: [
          this.#workspaceRoot,
          ...new Set([...this.#runtimeReadPaths, ...this.#readPaths]),
        ],
        writePaths: [...new Set(this.#writePaths)],
        networkTargets: [],
        commands: [[this.#executable, ...this.#server.arguments]],
        commandStdio,
        secretEnv: { ...this.#server.secretEnv },
        workingDirectory: this.#workspaceRoot,
        timeoutMs: this.#server.maxTimeoutMs,
        maxOutputBytes: this.#server.maxOutputBytes,
      },
      expectedEffects: [
        `Call MCP tool '${this.#manifest.name}' on server '${this.#server.name}'`,
        ...this.#writePaths.map((path) => `May modify ${path}`),
      ],
      verification: ['Receive the matching MCP JSON-RPC response'],
    }
  }

  async execute(): Promise<never> {
    throw new Error(
      'MCP actions must be executed by PlatformCommandSandbox, not in process',
    )
  }

  present(result: ActionResult, call: LlmToolCall): ActionResult {
    const invocationId = `${call.callId}:call`
    const output = result.output as {
      commands?: readonly { stdout?: string | undefined }[] | undefined
    }
    const stdout = output.commands?.[0]?.stdout ?? ''
    for (const line of stdout.split('\n')) {
      let candidate: unknown
      try {
        candidate = JSON.parse(line)
      } catch {
        continue
      }
      const response = JsonRpcResponseSchema.safeParse(candidate)
      if (!response.success || response.data.id !== invocationId) continue
      if (response.data.error !== undefined) {
        return {
          ...result,
          output: response.data.error,
          content: response.data.error.message,
          isError: true,
        }
      }
      const presented = responseContent(response.data.result)
      return {
        ...result,
        output: response.data.result,
        content: presented.content,
        ...(presented.isError ? { isError: true } : { isError: undefined }),
      }
    }
    const diagnostic = result.content.trim()
    return {
      ...result,
      content:
        diagnostic === ''
          ? 'MCP server did not return the matching JSON-RPC response'
          : `MCP server did not return the matching JSON-RPC response:\n${diagnostic}`,
      isError: true,
    }
  }
}

/** Validates a pinned server/tool manifest and creates one adapter per tool. */
export function createMcpToolAdapters(input: unknown): ToolAdapter[] {
  const server = McpServerManifestSchema.parse(input)
  const ids = new Set<string>()
  return server.tools.map((manifest) => {
    const id = toolId(server.name, manifest.name)
    if (ids.has(id)) throw new Error(`Duplicate MCP tool '${id}'`)
    ids.add(id)
    return new McpToolAdapter(server, manifest)
  })
}
