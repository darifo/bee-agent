import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ActionRequest, SandboxProvider } from '../src/execution-world.ts'
import {
  PlatformCommandSandbox,
  RoutingSandboxProvider,
  SandboxCancelledError,
  SandboxUnavailableError,
  buildBubblewrapArgs,
  buildSeatbeltProfile,
} from '../src/platform-sandbox.ts'

function request(
  requirements: Partial<ActionRequest['requirements']> = {},
): ActionRequest {
  return {
    id: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    capability: 'tool:command',
    subject: { type: 'agent', id: 'bee' },
    input: {},
    requirements: {
      readPaths: [],
      writePaths: [],
      networkTargets: [],
      commands: [['/bin/echo', 'hello']],
      secretEnv: {},
      ...requirements,
    },
    expectedEffects: [],
    verification: [],
    scope: { threadId: 'thread-1', turnId: 'turn-1' },
  }
}

describe('platform sandbox policies', () => {
  it('builds a deny-default Seatbelt policy from declared resources', () => {
    const profile = buildSeatbeltProfile(
      request({
        readPaths: ['/tmp/input'],
        writePaths: ['/tmp/output'],
      }),
    )
    expect(profile).toContain('(deny default)')
    expect(profile).toContain('(literal "/bin/echo")')
    expect(profile).toContain('(allow file-read-metadata (literal "/bin"))')
    expect(profile).toContain('(literal "/dev/urandom")')
    expect(profile).toContain('(subpath "/tmp/input")')
    expect(profile).toContain('(subpath "/tmp/output")')
    expect(profile).not.toContain('(allow network')
  })

  it('builds a namespace-isolated bwrap invocation with exact mounts', () => {
    const action = request({
      readPaths: ['/tmp/input'],
      writePaths: ['/tmp/output'],
      workingDirectory: '/tmp/output',
    })
    const args = buildBubblewrapArgs(action, ['/bin/echo', 'hello'])
    expect(args).toContain('--unshare-all')
    expect(args).toContain('--die-with-parent')
    expect(args).toContain('--ro-bind')
    expect(args).toContain('--bind')
    expect(args).toContain('--chdir')
    expect(args.slice(-3)).toEqual(['--', '/bin/echo', 'hello'])
  })

  it('fails closed when no enforcing provider exists', async () => {
    const sandbox = new PlatformCommandSandbox('win32')
    await expect(
      sandbox.execute(request(), { secrets: new Map() }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError)
    await expect(sandbox.capabilities()).resolves.toMatchObject({
      filesystemIsolation: false,
      processIsolation: false,
    })
  })

  it('routes snapshots, capabilities, and execution by request', async () => {
    const selected: string[] = []
    const provider = (name: string): SandboxProvider => ({
      async execute() {
        selected.push(`execute:${name}`)
        return { output: name, content: name, verification: [] }
      },
      async snapshot() {
        selected.push(`snapshot:${name}`)
        return { ref: name, capturedAt: new Date().toISOString() }
      },
      async diff(before, after) {
        return { before, after }
      },
      async capabilities() {
        selected.push(`capabilities:${name}`)
        return {
          provider: name,
          filesystemIsolation: false,
          networkIsolation: false,
          processIsolation: false,
        }
      },
    })
    const logical = provider('logical')
    const process = provider('process')
    const router = new RoutingSandboxProvider((action) =>
      action.requirements.commands.length > 0 ? process : logical,
    )
    const action = request()
    await router.capabilities(action)
    const before = await router.snapshot(action)
    await router.execute(action, { secrets: new Map() })
    const after = await router.snapshot(action)
    await expect(router.diff(before, after)).resolves.toEqual({ before, after })
    expect(selected).toEqual([
      'capabilities:process',
      'snapshot:process',
      'execute:process',
      'snapshot:process',
    ])
  })

  it.runIf(
    process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'),
  )(
    'executes under Seatbelt or reports that nesting is unavailable',
    async () => {
      const sandbox = new PlatformCommandSandbox()
      const capabilities = await sandbox.capabilities()
      if (!capabilities.processIsolation) {
        await expect(
          sandbox.execute(request(), { secrets: new Map() }),
        ).rejects.toBeInstanceOf(SandboxUnavailableError)
        return
      }
      const outcome = await sandbox.execute(request(), {
        secrets: new Map(),
      })
      expect(outcome.isError).toBeUndefined()
      expect(outcome.content).toBe('hello\n')
    },
  )

  it.runIf(
    process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'),
  )('delivers declared standard input to one sandboxed command', async () => {
    const sandbox = new PlatformCommandSandbox()
    if (!(await sandbox.capabilities()).processIsolation) return
    const outcome = await sandbox.execute(
      request({
        commands: [['/bin/cat']],
        commandStdin: 'input-through-sandbox\n',
      }),
      { secrets: new Map() },
    )
    expect(outcome.content).toBe('input-through-sandbox\n')
  })

  it.runIf(
    process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'),
  )('kills the complete Seatbelt process group on cancellation', async () => {
    const sandbox = new PlatformCommandSandbox()
    if (!(await sandbox.capabilities()).processIsolation) return

    const directory = await mkdtemp(join(tmpdir(), 'bee-sandbox-'))
    const canonicalDirectory = await realpath(directory)
    const pidFile = join(canonicalDirectory, 'child.pid')
    const controller = new AbortController()
    try {
      const action = request({
        writePaths: [canonicalDirectory],
        workingDirectory: canonicalDirectory,
        commands: [
          [
            '/bin/bash',
            '-c',
            `(while :; do :; done) & child=$!; echo "$child" > ${JSON.stringify(pidFile)}; wait`,
          ],
        ],
        timeoutMs: 5_000,
      })
      const execution = sandbox.execute(action, {
        secrets: new Map(),
        signal: controller.signal,
      })
      let childPid: number | undefined
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          childPid = Number((await readFile(pidFile, 'utf8')).trim())
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      expect(childPid).toBeTypeOf('number')
      controller.abort()
      await expect(execution).rejects.toBeInstanceOf(SandboxCancelledError)

      let alive = true
      for (let attempt = 0; attempt < 100 && alive; attempt += 1) {
        try {
          process.kill(childPid as number, 0)
          await new Promise((resolve) => setTimeout(resolve, 10))
        } catch {
          alive = false
        }
      }
      expect(alive).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.runIf(
    process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'),
  )('returns bounded stderr as model-visible error content', async () => {
    const sandbox = new PlatformCommandSandbox()
    if (!(await sandbox.capabilities()).processIsolation) return
    const outcome = await sandbox.execute(
      request({
        commands: [['/bin/bash', '-c', 'echo command-failed >&2; exit 7']],
      }),
      { secrets: new Map() },
    )
    expect(outcome.isError).toBe(true)
    expect(outcome.content).toContain('command-failed\n')
  })
})
