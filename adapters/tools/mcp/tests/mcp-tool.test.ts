import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ChronicleSchemaRegistry } from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import {
  ExecutionWorld,
  PlatformCommandSandbox,
  StaticAuthorizationPolicy,
  ToolExecutionService,
  registerExecutionChronicleEvents,
} from '@bee-agent/runtime'
import { createMcpToolAdapters } from '../src/index.ts'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureServer = join(packageRoot, 'tests', 'fixtures', 'server.mjs')
const nodeRuntimeRoot = join(dirname(process.execPath), '..')

function adapters() {
  return createMcpToolAdapters({
    name: 'fixture',
    protocolVersion: 'test-version',
    executable: process.execPath,
    arguments: [fixtureServer],
    workspaceRoot: packageRoot,
    runtimeReadPaths: [nodeRuntimeRoot],
    readPaths: ['tests/fixtures'],
    tools: [
      {
        name: 'greet',
        description: 'Return a fixture greeting.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
      },
    ],
  })
}

describe('MCP tool adapters', () => {
  it('creates manifest-pinned specs and exact stdio declarations', async () => {
    const [adapter] = adapters()
    expect(adapter).toBeDefined()
    const call = {
      callId: 'call-1',
      toolId: 'mcp__fixture__greet',
      input: { name: 'Bee' },
    }
    const descriptor = adapter?.describe(call)
    expect(adapter?.spec).toMatchObject({
      id: 'mcp__fixture__greet',
      description: 'Return a fixture greeting.',
    })
    expect(adapter?.authorization.decision).toBe('ask')
    expect(descriptor?.requirements).toMatchObject({
      commands: [[await realpath(process.execPath), fixtureServer]],
      networkTargets: [],
    })
    expect(descriptor?.requirements.commandStdio).toMatchObject({
      kind: 'json-lines',
      steps: [
        { waitFor: { equals: 'call-1:initialize' } },
        { input: expect.stringContaining('notifications/initialized') },
        { waitFor: { equals: 'call-1:call' } },
      ],
    })
  })

  it('rejects duplicate tools and workspace escapes', () => {
    expect(() =>
      createMcpToolAdapters({
        name: 'fixture',
        protocolVersion: 'test-version',
        executable: process.execPath,
        workspaceRoot: packageRoot,
        writePaths: ['..'],
        tools: [
          { name: 'greet', description: 'one', inputSchema: {} },
          { name: 'greet', description: 'two', inputSchema: {} },
        ],
      }),
    ).toThrow()
  })

  it('cannot execute a server in the adapter process', async () => {
    const [adapter] = adapters()
    await expect(
      adapter?.execute({
        call: {
          callId: 'call-direct',
          toolId: 'mcp__fixture__greet',
          input: {},
        },
        threadId: 'thread-direct',
        turnId: 'turn-direct',
        itemId: crypto.randomUUID(),
      }),
    ).rejects.toThrow('must be executed by PlatformCommandSandbox')
  })

  it('keeps sandbox diagnostics when no matching response exists', () => {
    const [adapter] = adapters()
    const presented = adapter?.present?.(
      {
        output: { commands: [{ stdout: '', stderr: 'server crashed' }] },
        content: 'server crashed',
        isError: true,
        verification: [],
      },
      {
        callId: 'call-crashed',
        toolId: 'mcp__fixture__greet',
        input: {},
      },
    )
    expect(presented).toMatchObject({
      isError: true,
      content: expect.stringContaining('server crashed'),
    })
  })

  it.runIf(
    process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'),
  )(
    'runs a real MCP stdio exchange through approval and Seatbelt',
    async () => {
      const sandbox = new PlatformCommandSandbox()
      if (!(await sandbox.capabilities()).processIsolation) return
      const [adapter] = adapters()
      if (adapter === undefined) throw new Error('fixture adapter missing')
      const registry = new ChronicleSchemaRegistry()
      registerExecutionChronicleEvents(registry)
      const world = new ExecutionWorld({
        store: new MemoryChronicleStore(registry),
        policy: new StaticAuthorizationPolicy([
          {
            capability: 'tool:mcp__fixture__greet',
            decision: 'ask',
            reason: 'MCP integration test',
          },
        ]),
        sandbox,
      })
      const service = new ToolExecutionService(world, adapter)
      const input = {
        call: {
          callId: 'call-mcp-seatbelt',
          toolId: 'mcp__fixture__greet',
          input: { name: 'Bee' },
        },
        threadId: 'thread-mcp',
        turnId: 'turn-mcp',
        itemId: crypto.randomUUID(),
      }
      await expect(service.execute(input)).resolves.toMatchObject({
        kind: 'approval-required',
      })
      const completed = await service.execute({
        ...input,
        approval: 'approved',
      })
      expect(completed, JSON.stringify(completed)).toMatchObject({
        kind: 'result',
        result: { content: 'hello Bee' },
      })
    },
  )
})
