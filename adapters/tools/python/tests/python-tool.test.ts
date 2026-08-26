import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
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
import { PYTHON_TOOL_ID, PythonToolAdapter } from '../src/index.ts'

const XCODE_PYTHON_ROOT =
  '/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework'
const XCODE_PYTHON = `${XCODE_PYTHON_ROOT}/Versions/3.9/Resources/Python.app/Contents/MacOS/Python`
const PYTHON_EXECUTABLE = existsSync(XCODE_PYTHON)
  ? XCODE_PYTHON
  : '/usr/bin/python3'
const PYTHON_RUNTIME_PATHS = [
  '/usr/lib',
  ...(existsSync(XCODE_PYTHON_ROOT) ? [XCODE_PYTHON_ROOT] : []),
]

async function fixture(maxInputBytes?: number) {
  const workspace = await mkdtemp(join(tmpdir(), 'bee-python-tool-'))
  await mkdir(join(workspace, 'output'))
  return {
    workspace,
    adapter: new PythonToolAdapter({
      workspaceRoot: workspace,
      executable: PYTHON_EXECUTABLE,
      runtimeReadPaths: PYTHON_RUNTIME_PATHS,
      maxInputBytes,
      maxTimeoutMs: 2_000,
      maxOutputBytes: 4_096,
    }),
  }
}

describe.runIf(existsSync(PYTHON_EXECUTABLE))('PythonToolAdapter', () => {
  it('expands code into one isolated sandbox command with stdin', async () => {
    const { workspace, adapter } = await fixture()
    try {
      const descriptor = adapter.describe({
        callId: 'call-1',
        toolId: PYTHON_TOOL_ID,
        input: {
          code: 'print(args["value"])',
          args: { value: 42 },
          readPaths: ['output'],
          writePaths: ['output'],
          timeoutMs: 9_999,
          maxOutputBytes: 9_999,
        },
      })
      const root = await realpath(workspace)
      expect(descriptor.requirements).toMatchObject({
        readPaths: [
          root,
          ...(await Promise.all(
            PYTHON_RUNTIME_PATHS.map((path) => realpath(path)),
          )),
          join(root, 'output'),
        ],
        writePaths: [join(root, 'output')],
        commands: [
          [await realpath(PYTHON_EXECUTABLE), '-I', '-c', expect.any(String)],
        ],
        workingDirectory: root,
        timeoutMs: 2_000,
        maxOutputBytes: 4_096,
      })
      expect(descriptor.requirements.commandStdin).toBe(
        JSON.stringify({ code: 'print(args["value"])', args: { value: 42 } }),
      )
      expect(adapter.authorization.decision).toBe('ask')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('rejects oversized input and canonical workspace escapes', async () => {
    const { workspace, adapter } = await fixture(64)
    const outside = await mkdtemp(join(tmpdir(), 'bee-python-outside-'))
    try {
      expect(() =>
        adapter.describe({
          callId: 'call-large',
          toolId: PYTHON_TOOL_ID,
          input: { code: 'x'.repeat(80) },
        }),
      ).toThrow('exceeds 64 bytes')
      await symlink(outside, join(workspace, 'outside-link'))
      expect(() =>
        adapter.describe({
          callId: 'call-escape',
          toolId: PYTHON_TOOL_ID,
          input: { code: 'pass', writePaths: ['outside-link'] },
        }),
      ).toThrow('escapes the configured workspace')
    } finally {
      await rm(outside, { recursive: true, force: true })
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

  it.runIf(process.platform === 'darwin')(
    'runs through approval and the real platform sandbox',
    async () => {
      const sandbox = new PlatformCommandSandbox()
      if (!(await sandbox.capabilities()).processIsolation) return
      const { workspace, adapter } = await fixture()
      try {
        const registry = new ChronicleSchemaRegistry()
        registerExecutionChronicleEvents(registry)
        const world = new ExecutionWorld({
          store: new MemoryChronicleStore(registry),
          policy: new StaticAuthorizationPolicy([
            {
              capability: `tool:${PYTHON_TOOL_ID}`,
              decision: 'ask',
              reason: 'python integration test',
            },
          ]),
          sandbox,
        })
        const service = new ToolExecutionService(world, adapter)
        const input = {
          call: {
            callId: 'call-python-seatbelt',
            toolId: PYTHON_TOOL_ID,
            input: {
              code: 'print(args["message"])',
              args: { message: 'hello-from-python' },
            },
          },
          threadId: 'thread-python',
          turnId: 'turn-python',
          itemId: crypto.randomUUID(),
        }
        await expect(service.execute(input)).resolves.toMatchObject({
          kind: 'approval-required',
        })
        await expect(
          service.execute({ ...input, approval: 'approved' }),
        ).resolves.toMatchObject({
          kind: 'result',
          result: { content: expect.stringContaining('hello-from-python\n') },
        })
      } finally {
        await rm(workspace, { recursive: true, force: true })
      }
    },
  )
})
