import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@bee-agent/contracts'
import { MockAgent } from '@bee-agent/runtime'
import { buildServer } from '../src/index.ts'

const FIXTURE = new URL(
  '../../../plugins/tools/mcp/tests/fixtures/echo-server.mjs',
  import.meta.url,
)

describe('server with an MCP tool server', () => {
  it('exposes MCP tools to tasks and stops the child with the kernel', async () => {
    const server = await buildServer({
      sqliteFilename: ':memory:',
      logger: false,
      mcpServers: [
        {
          name: 'echo-server',
          command: process.execPath,
          args: [FIXTURE.pathname],
        },
      ],
    })
    try {
      expect(server.runtime.tools.has('mcp.echo-server.echo')).toBe(true)
      expect(server.runtime.tools.has('mcp.echo-server.failing')).toBe(true)

      // A mock-agent script drives the MCP tool through the full runtime
      // pipeline (policy interception, event sourcing).
      server.runtime.registerAgent(
        new MockAgent({
          id: 'agent.mcp-test',
          script: [
            { kind: 'say', content: 'calling the MCP echo tool' },
            {
              kind: 'tool',
              toolId: 'mcp.echo-server.echo',
              input: { text: 'roundtrip' },
            },
          ],
        }),
      )
      const spec = await server.runtime.createTask({
        input: 'run the echo tool',
        agentId: 'agent.mcp-test',
        metadata: {},
      })
      await server.runtime.run(spec.id)
      const events: AgentEvent[] = []
      for await (const event of server.runtime.readEvents(spec.id)) {
        events.push(event)
      }
      const toolResults = events.filter((event) => event.type === 'tool.result')
      expect(toolResults).toHaveLength(1)
      expect(toolResults[0]?.payload).toMatchObject({
        result: {
          callId: expect.any(String),
          output: 'echo: roundtrip',
        },
      })
      const snapshot = await server.runtime.getSnapshot(spec.id)
      expect(snapshot.state).toBe('completed')
    } finally {
      // Closing the app stops the kernel, which stops the child process.
      await server.app.close()
    }
  })

  it('rejects malformed BEE_AGENT_MCP-style configs by shape', async () => {
    await expect(
      buildServer({
        sqliteFilename: ':memory:',
        logger: false,
        mcpServers: [{ name: '', command: 'node' }],
      }),
    ).rejects.toThrow()
  })
})
