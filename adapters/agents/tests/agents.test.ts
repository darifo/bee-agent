import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '@bee-agent/runtime'
import type { AgentRunContext } from '@bee-agent/runtime'
import {
  CommandAgent,
  CommandAgentConfigSchema,
  CommandAgentError,
} from '../src/index.ts'

// RemoteAgent and federation tests moved to apps/server/tests/federation.test.ts:
// they need the server composition root, and a reverse devDep here created a
// workspace build cycle.

function runContext(input: string): AgentRunContext {
  return {
    taskId: randomUUID(),
    input,
    metadata: {},
    workspaceId: undefined,
    tools: new ToolRegistry(),
    cancelled: false,
    throwIfCancelled: () => {},
    emit: async () => {},
    emitMessage: async () => {},
    callTool: async () => {
      throw new Error('not expected in these tests')
    },
  }
}

describe('CommandAgent', () => {
  it('wraps argv-driven programs with {input} placeholders', async () => {
    const echo = new CommandAgent({
      id: 'agent.argv',
      command: '/bin/echo',
      args: ['heard:', '{input}'],
    })
    const result = await echo.run(runContext('hello adapter'))
    expect(result.output).toBe('heard: hello adapter\n')
  })

  it('feeds stdin when inputVia is stdin', async () => {
    const agent = new CommandAgent({
      id: 'agent.stdin',
      command: process.execPath,
      args: [
        '-e',
        'process.stdin.resume(); let d=""; process.stdin.on("data", c => d += c); process.stdin.on("end", () => process.stdout.write(d.toUpperCase()))',
      ],
      inputVia: 'stdin',
    })
    const result = await agent.run(runContext('shout this'))
    expect(result.output).toBe('SHOUT THIS')
  })

  it('maps non-zero exits and timeouts to errors', async () => {
    const failing = new CommandAgent({
      id: 'agent.fail',
      command: process.execPath,
      args: ['-e', 'process.stderr.write("boom\\n"); process.exit(3)'],
    })
    await expect(failing.run(runContext('x'))).rejects.toThrow(
      /exited with code 3.*boom/,
    )

    const slow = new CommandAgent({
      id: 'agent.slow',
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30000)'],
      timeoutMs: 300,
    })
    await expect(slow.run(runContext('x'))).rejects.toThrow(CommandAgentError)
  })

  it('validates configs by schema', () => {
    expect(() =>
      CommandAgentConfigSchema.parse({ id: '', command: 'node' }),
    ).toThrow()
    expect(
      CommandAgentConfigSchema.parse({ id: 'a', command: 'node' }),
    ).toMatchObject({ args: [], inputVia: 'args' })
  })
})
