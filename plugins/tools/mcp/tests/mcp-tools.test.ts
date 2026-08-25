import { describe, expect, it } from 'vitest'
import {
  McpClient,
  McpClientError,
  McpToolError,
  McpToolsPlugin,
  mcpToolId,
} from '../src/index.ts'

const FIXTURE = new URL('./fixtures/echo-server.mjs', import.meta.url)

function fixtureConfig() {
  return {
    name: 'echo-server',
    command: process.execPath,
    args: [FIXTURE.pathname],
  }
}

describe('McpToolsPlugin', () => {
  it('discovers tools and namespaces their ids', async () => {
    const plugin = new McpToolsPlugin(fixtureConfig())
    await plugin.start()
    try {
      expect(plugin.tools.map((tool) => tool.manifest.id)).toEqual([
        'mcp.echo-server.echo',
        'mcp.echo-server.failing',
        'mcp.echo-server.rich',
      ])
      const echo = plugin.tools[0]
      expect(echo?.manifest.description).toBe('Echoes the given text back')
      expect(echo?.manifest.inputSchema).toMatchObject({
        type: 'object',
        required: ['text'],
      })
    } finally {
      await plugin.stop()
    }
  })

  it('executes tools over the stdio JSON-RPC bridge', async () => {
    const plugin = new McpToolsPlugin(fixtureConfig())
    await plugin.start()
    try {
      const echo = plugin.tools[0]
      if (echo === undefined) throw new Error('echo tool missing')
      await expect(echo.execute({ text: 'hi' }, fakeContext())).resolves.toBe(
        'echo: hi',
      )
    } finally {
      await plugin.stop()
    }
  })

  it('maps isError results to thrown tool errors', async () => {
    const plugin = new McpToolsPlugin(fixtureConfig())
    await plugin.start()
    try {
      const failing = plugin.tools[1]
      if (failing === undefined) throw new Error('failing tool missing')
      await expect(failing.execute({}, fakeContext())).rejects.toThrow(
        McpToolError,
      )
      await expect(failing.execute({}, fakeContext())).rejects.toThrow(
        /boom: not allowed/,
      )
    } finally {
      await plugin.stop()
    }
  })

  it('keeps multi-content results structured', async () => {
    const plugin = new McpToolsPlugin(fixtureConfig())
    await plugin.start()
    try {
      const rich = plugin.tools[2]
      if (rich === undefined) throw new Error('rich tool missing')
      await expect(rich.execute({}, fakeContext())).resolves.toEqual({
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      })
    } finally {
      await plugin.stop()
    }
  })

  it('terminates the child process on stop', async () => {
    const plugin = new McpToolsPlugin(fixtureConfig())
    await plugin.start()
    const client = new McpClient(fixtureConfig())
    await client.start()
    await client.close()
    await expect(client.callTool('echo', {})).rejects.toThrow(McpClientError)

    // The plugin path also closes cleanly (idempotent second stop).
    await plugin.stop()
    await plugin.stop()
  })

  it('rejects unknown methods with the server error message', async () => {
    const client = new McpClient(fixtureConfig())
    await client.start()
    try {
      await expect(client.callTool('nonexistent', {})).rejects.toThrow(
        /unknown tool nonexistent/,
      )
    } finally {
      await client.close()
    }
  })
})

describe('mcpToolId', () => {
  it('namespaces server and tool', () => {
    expect(mcpToolId('fs', 'read_file')).toBe('mcp.fs.read_file')
  })
})

function fakeContext(): { taskId: string; callId: string } {
  return { taskId: 'task-1', callId: 'call-1' }
}
