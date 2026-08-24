import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

export const McpServerConfigSchema = z.object({
  /** Server name; namespaces every discovered tool (`mcp.<name>.<tool>`). */
  name: z.string().min(1),
  /** Executable that starts the MCP server (stdio transport). */
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
})
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>

/** One tool as advertised by `tools/list`. */
export interface McpToolDescriptor {
  readonly name: string
  readonly description?: string | undefined
  readonly inputSchema: Record<string, unknown>
}

export class McpClientError extends Error {
  constructor(
    message: string,
    readonly code?: number | undefined,
  ) {
    super(message)
    this.name = 'McpClientError'
  }
}

interface PendingRequest {
  resolve(result: Record<string, unknown>): void
  reject(error: unknown): void
  timer: ReturnType<typeof setTimeout>
}

const PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/**
 * Minimal MCP client over the stdio transport: newline-delimited JSON-RPC
 * 2.0 on the child's stdin/stdout (ADR 0014, zero dependencies). Each
 * server runs in its own child process, which is the isolation boundary
 * ADR 0007 asks for.
 */
export class McpClient {
  readonly config: McpServerConfig
  readonly #requestTimeoutMs: number
  #process: ChildProcessWithoutNullStreams | undefined
  #pending = new Map<string, PendingRequest>()
  #buffer = ''
  #closed = false
  #stderrTail = ''
  readonly #exitWaiters: ((code: number | null) => void)[] = []

  constructor(
    config: McpServerConfig,
    options: { requestTimeoutMs?: number | undefined } = {},
  ) {
    this.config = config
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  /** Spawns the server and completes the initialize handshake. */
  async start(): Promise<void> {
    if (this.#closed) throw new McpClientError('MCP client already closed')
    const child = spawn(this.config.command, [...(this.config.args ?? [])], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env },
    })
    this.#process = child
    child.on('error', (error) => {
      this.#failAllPending(
        new McpClientError(
          `MCP server '${this.config.name}' failed: ${String(error)}`,
        ),
      )
    })
    child.on('exit', (code) => {
      const tail = this.#stderrTail.trim()
      this.#failAllPending(
        new McpClientError(
          `MCP server '${this.config.name}' exited with code ${String(code)}${tail.length > 0 ? `: ${tail}` : ''}`,
        ),
      )
      for (const wait of this.#exitWaiters.splice(0)) wait(code)
    })
    if (child.stderr !== null) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-500)
      })
    }
    if (child.stdout === null || child.stdin === null) {
      throw new McpClientError('MCP server spawned without stdio pipes')
    }
    // Writing to a dead server must not crash the process with EPIPE.
    child.stdin.on('error', () => {})
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      this.#buffer += chunk
      let newline = this.#buffer.indexOf('\n')
      while (newline >= 0) {
        const line = this.#buffer.slice(0, newline).trim()
        this.#buffer = this.#buffer.slice(newline + 1)
        if (line.length > 0) this.#handleMessage(line)
        newline = this.#buffer.indexOf('\n')
      }
    })

    const response = await this.#request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'bee-agent', version: '0.1.0' },
    })
    const capabilities = response.capabilities
    if (
      typeof capabilities !== 'object' ||
      capabilities === null ||
      !('tools' in capabilities)
    ) {
      throw new McpClientError(
        `MCP server '${this.config.name}' does not advertise the tools capability`,
      )
    }
    this.#notify('notifications/initialized')
  }

  async listTools(): Promise<readonly McpToolDescriptor[]> {
    const response = await this.#request('tools/list', {})
    const tools = response.tools
    if (!Array.isArray(tools)) {
      throw new McpClientError(
        `MCP server '${this.config.name}' returned no tools[] in tools/list`,
      )
    }
    return tools.map((entry) => {
      const record =
        typeof entry === 'object' && entry !== null
          ? (entry as Record<string, unknown>)
          : {}
      const name = record.name
      if (typeof name !== 'string' || name.length === 0) {
        throw new McpClientError(
          `MCP server '${this.config.name}' advertised a tool without a name`,
        )
      }
      return {
        name,
        description:
          typeof record.description === 'string'
            ? record.description
            : undefined,
        inputSchema:
          typeof record.inputSchema === 'object' && record.inputSchema !== null
            ? (record.inputSchema as Record<string, unknown>)
            : {},
      }
    })
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.#request('tools/call', { name, arguments: args })
  }

  /** Kills the child process and rejects outstanding requests. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#failAllPending(new McpClientError('MCP client closed'))
    const child = this.#process
    if (
      child === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return
    }
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000)
      this.#exitWaiters.push(() => {
        clearTimeout(killTimer)
        resolve()
      })
      child.kill('SIGTERM')
    })
  }

  #request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.#closed) {
      return Promise.reject(new McpClientError('MCP client closed'))
    }
    const id = `bee-${randomUUID()}`
    const child = this.#process
    if (child === undefined || child.stdin === null) {
      return Promise.reject(
        new McpClientError('MCP client is not connected to a server'),
      )
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(
          new McpClientError(
            `MCP request '${method}' to '${this.config.name}' timed out after ${this.#requestTimeoutMs}ms`,
          ),
        )
      }, this.#requestTimeoutMs)
      this.#pending.set(id, {
        resolve: (result) => resolve(result),
        reject,
        timer,
      })
      this.#send({ jsonrpc: '2.0', id, method, params })
    })
  }

  #notify(method: string): void {
    this.#send({ jsonrpc: '2.0', method })
  }

  #send(message: Record<string, unknown>): void {
    const child = this.#process
    if (child === undefined || child.stdin === null) {
      throw new McpClientError('MCP client is not connected to a server')
    }
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #handleMessage(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return // server chatter that is not JSON-RPC is ignored
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const message = parsed as Record<string, unknown>
    if (message.id === undefined) return // notifications from the server
    const pending = this.#pending.get(String(message.id))
    if (pending === undefined) return
    this.#pending.delete(String(message.id))
    clearTimeout(pending.timer)
    if ('error' in message) {
      const error = message.error as Record<string, unknown> | undefined
      pending.reject(
        new McpClientError(
          `MCP server '${this.config.name}' error: ${String(error?.message ?? 'unknown')}`,
          typeof error?.code === 'number' ? error.code : undefined,
        ),
      )
      return
    }
    const result = message.result
    pending.resolve(
      typeof result === 'object' && result !== null
        ? (result as Record<string, unknown>)
        : {},
    )
  }

  #failAllPending(error: McpClientError): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }
}
