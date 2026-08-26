import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { COMMAND_TOOL_ID, CommandToolAdapter } from '../src/index.ts'

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'bee-command-tool-'))
  await mkdir(join(workspace, 'output'))
  return {
    workspace,
    adapter: new CommandToolAdapter({
      workspaceRoot: workspace,
      allowedExecutables: ['/bin/echo'],
      secretEnv: { API_KEY: 'keychain:bee/model' },
      maxTimeoutMs: 2_000,
      maxOutputBytes: 4_096,
    }),
  }
}

describe('CommandToolAdapter', () => {
  it('expands model input into an exact sandbox declaration', async () => {
    const { workspace, adapter } = await fixture()
    try {
      const descriptor = adapter.describe({
        callId: 'call-1',
        toolId: COMMAND_TOOL_ID,
        input: {
          executable: await realpath('/bin/echo'),
          arguments: ['hello'],
          cwd: '.',
          readPaths: ['output'],
          writePaths: ['output'],
          timeoutMs: 9_999,
          maxOutputBytes: 9_999,
        },
      })
      const canonicalWorkspace = await realpath(workspace)
      expect(descriptor.capability).toBe('tool:command_run')
      expect(descriptor.requirements).toMatchObject({
        commands: [[await realpath('/bin/echo'), 'hello']],
        readPaths: [canonicalWorkspace, join(canonicalWorkspace, 'output')],
        writePaths: [join(canonicalWorkspace, 'output')],
        secretEnv: { API_KEY: 'keychain:bee/model' },
        workingDirectory: canonicalWorkspace,
        timeoutMs: 2_000,
        maxOutputBytes: 4_096,
      })
      expect(adapter.authorization.decision).toBe('ask')
      expect(adapter.spec.inputSchema).toMatchObject({
        additionalProperties: false,
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('rejects undeclared executables and workspace escapes', async () => {
    const { workspace, adapter } = await fixture()
    try {
      const echo = await realpath('/bin/echo')
      expect(() =>
        adapter.describe({
          callId: 'call-2',
          toolId: COMMAND_TOOL_ID,
          input: { executable: '/usr/bin/true' },
        }),
      ).toThrow('not allowed')
      expect(() =>
        adapter.describe({
          callId: 'call-3',
          toolId: COMMAND_TOOL_ID,
          input: { executable: echo, cwd: '..' },
        }),
      ).toThrow('escapes the command workspace')

      const outside = await mkdtemp(join(tmpdir(), 'bee-command-outside-'))
      try {
        await symlink(outside, join(workspace, 'outside-link'))
        expect(() =>
          adapter.describe({
            callId: 'call-4',
            toolId: COMMAND_TOOL_ID,
            input: { executable: echo, readPaths: ['outside-link'] },
          }),
        ).toThrow('escapes the command workspace')
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('cannot execute outside the platform sandbox', async () => {
    const { workspace, adapter } = await fixture()
    try {
      await expect(adapter.execute()).rejects.toThrow(
        'must be executed by PlatformCommandSandbox',
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('requires native executable entrypoints', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'bee-command-script-'))
    const script = join(workspace, 'script')
    try {
      await writeFile(script, '#!/bin/sh\necho unsafe indirection\n')
      await chmod(script, 0o755)
      expect(
        () =>
          new CommandToolAdapter({
            workspaceRoot: workspace,
            allowedExecutables: [script],
          }),
      ).toThrow('allow the interpreter')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'darwin')(
    'executes only through approval and the real platform sandbox',
    async () => {
      const sandbox = new PlatformCommandSandbox()
      if (!(await sandbox.capabilities()).processIsolation) return
      const workspace = await mkdtemp(join(tmpdir(), 'bee-command-world-'))
      try {
        const adapter = new CommandToolAdapter({
          workspaceRoot: workspace,
          allowedExecutables: ['/bin/echo'],
        })
        const registry = new ChronicleSchemaRegistry()
        registerExecutionChronicleEvents(registry)
        const world = new ExecutionWorld({
          store: new MemoryChronicleStore(registry),
          policy: new StaticAuthorizationPolicy([
            {
              capability: `tool:${COMMAND_TOOL_ID}`,
              decision: 'ask',
              reason: 'command integration test',
            },
          ]),
          sandbox,
        })
        const service = new ToolExecutionService(world, adapter)
        const input = {
          call: {
            callId: 'call-seatbelt',
            toolId: COMMAND_TOOL_ID,
            input: {
              executable: await realpath('/bin/echo'),
              arguments: ['hello-from-sandbox'],
            },
          },
          threadId: 'thread-command',
          turnId: 'turn-command',
          itemId: crypto.randomUUID(),
        }
        const pending = await service.execute(input)
        expect(pending).toMatchObject({ kind: 'approval-required' })
        if (pending.kind === 'approval-required') {
          expect(pending.detail).toContain('hello-from-sandbox')
          expect(pending.detail).toContain(await realpath(workspace))
        }

        const completed = await service.execute({
          ...input,
          approval: 'approved',
        })
        expect(completed).toMatchObject({
          kind: 'result',
          result: { content: 'hello-from-sandbox\n' },
        })
      } finally {
        await rm(workspace, { recursive: true, force: true })
      }
    },
  )
})
