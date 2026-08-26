import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import type {
  ActionRequest,
  ActionResult,
  SandboxCapabilityReport,
  SandboxProvider,
  WorldSnapshot,
} from './execution-world.ts'

export class SandboxUnavailableError extends Error {
  constructor(readonly provider: string) {
    super(`Sandbox provider '${provider}' is unavailable on this host`)
    this.name = 'SandboxUnavailableError'
  }
}

export class SandboxOutputLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Sandbox output exceeded ${limit} bytes`)
    this.name = 'SandboxOutputLimitError'
  }
}

export class SandboxTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Sandbox command exceeded ${timeoutMs}ms`)
    this.name = 'SandboxTimeoutError'
  }
}

export class SandboxCancelledError extends Error {
  constructor() {
    super('Sandbox command cancelled')
    this.name = 'SandboxCancelledError'
  }
}

/** Selects a provider per fully expanded request. */
export class RoutingSandboxProvider implements SandboxProvider {
  readonly #select: (request: ActionRequest) => SandboxProvider
  readonly #snapshotOwners = new WeakMap<WorldSnapshot, SandboxProvider>()

  constructor(select: (request: ActionRequest) => SandboxProvider) {
    this.#select = select
  }

  execute(
    request: ActionRequest,
    options: {
      readonly signal?: AbortSignal | undefined
      readonly secrets: ReadonlyMap<string, string>
    },
  ): Promise<ActionResult> {
    return this.#select(request).execute(request, options)
  }

  async snapshot(request: ActionRequest): Promise<WorldSnapshot> {
    const provider = this.#select(request)
    const snapshot = await provider.snapshot(request)
    this.#snapshotOwners.set(snapshot, provider)
    return snapshot
  }

  diff(before: WorldSnapshot, after: WorldSnapshot): Promise<unknown> {
    const provider = this.#snapshotOwners.get(before)
    if (
      provider === undefined ||
      provider !== this.#snapshotOwners.get(after)
    ) {
      throw new Error('Sandbox snapshots do not belong to the same provider')
    }
    return provider.diff(before, after)
  }

  capabilities(request: ActionRequest): Promise<SandboxCapabilityReport> {
    return this.#select(request).capabilities(request)
  }
}

interface ProcessResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly completedByOutput?: boolean | undefined
}

async function runProcess(input: {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd?: string | undefined
  readonly env: Readonly<Record<string, string>>
  readonly stdin?: string | undefined
  readonly stdoutCompletion?:
    | {
        readonly property: string
        readonly equals: string | number
      }
    | undefined
  readonly stdioSequence?:
    | {
        readonly steps: readonly {
          readonly input: string
          readonly waitFor?:
            | {
                readonly property: string
                readonly equals: string | number
              }
            | undefined
        }[]
      }
    | undefined
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted === true) {
      reject(new SandboxCancelledError())
      return
    }
    const child = spawn(input.executable, [...input.args], {
      cwd: input.cwd,
      env: { ...input.env },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let size = 0
    let settled = false
    let completedByOutput = false
    let stdoutLineBuffer = ''
    let stdioStep = 0
    let stagedWait:
      | { readonly property: string; readonly equals: string | number }
      | undefined
    const timeout: {
      timer?: ReturnType<typeof setTimeout>
      completionTimer?: ReturnType<typeof setTimeout>
    } = {}
    const killTree = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        child.kill(signal)
      }
    }
    const finishError = (error: Error) => {
      if (settled) return
      settled = true
      if (timeout.timer !== undefined) clearTimeout(timeout.timer)
      if (timeout.completionTimer !== undefined)
        clearTimeout(timeout.completionTimer)
      input.signal?.removeEventListener('abort', onAbort)
      killTree('SIGKILL')
      reject(error)
    }
    const append = (target: Buffer[], chunk: Buffer) => {
      size += chunk.byteLength
      if (size > input.maxOutputBytes) {
        finishError(new SandboxOutputLimitError(input.maxOutputBytes))
        return
      }
      target.push(chunk)
    }
    const completeByOutput = () => {
      if (completedByOutput) return
      completedByOutput = true
      killTree('SIGTERM')
      timeout.completionTimer = setTimeout(() => killTree('SIGKILL'), 250)
      timeout.completionTimer.unref()
    }
    const pumpStdio = () => {
      const steps = input.stdioSequence?.steps
      if (steps === undefined) return
      while (stagedWait === undefined && stdioStep < steps.length) {
        const step = steps[stdioStep]
        if (step === undefined) break
        child.stdin.write(step.input)
        stagedWait = step.waitFor
        if (stagedWait === undefined) stdioStep += 1
      }
    }
    const inspectStdout = (chunk: Buffer) => {
      if (
        (input.stdoutCompletion === undefined && stagedWait === undefined) ||
        completedByOutput
      )
        return
      stdoutLineBuffer += chunk.toString('utf8')
      const lines = stdoutLineBuffer.split('\n')
      stdoutLineBuffer = lines.pop() ?? ''
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as Record<string, unknown>
          const completion = stagedWait ?? input.stdoutCompletion
          if (
            completion !== undefined &&
            message[completion.property] === completion.equals
          ) {
            if (stagedWait !== undefined) {
              stagedWait = undefined
              stdioStep += 1
              if (stdioStep < (input.stdioSequence?.steps.length ?? 0)) {
                pumpStdio()
              } else {
                completeByOutput()
              }
            } else {
              completeByOutput()
            }
            break
          }
        } catch {
          // Non-JSON stdout remains captured for adapter-level diagnostics.
        }
      }
    }
    child.stdout.on('data', (chunk: Buffer) => {
      append(stdout, chunk)
      inspectStdout(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk))
    child.stdin.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') finishError(error)
    })
    if (input.stdioSequence !== undefined) pumpStdio()
    else child.stdin.end(input.stdin)
    child.once('error', finishError)
    child.once('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      if (timeout.timer !== undefined) clearTimeout(timeout.timer)
      if (timeout.completionTimer !== undefined)
        clearTimeout(timeout.completionTimer)
      input.signal?.removeEventListener('abort', onAbort)
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        ...(completedByOutput ? { completedByOutput: true } : {}),
      })
    })
    const onAbort = () => finishError(new SandboxCancelledError())
    input.signal?.addEventListener('abort', onAbort, { once: true })
    timeout.timer = setTimeout(
      () => finishError(new SandboxTimeoutError(input.timeoutMs)),
      input.timeoutMs,
    )
    timeout.timer.unref()
  })
}

function quoteScheme(value: string): string {
  return JSON.stringify(value)
}

function pathAncestors(path: string): string[] {
  const ancestors: string[] = []
  let parent = dirname(path)
  while (parent !== '/') {
    ancestors.push(parent)
    parent = dirname(parent)
  }
  return ancestors
}

export function buildSeatbeltProfile(
  request: ActionRequest,
  command: readonly string[] | undefined = undefined,
): string {
  const commands =
    command === undefined ? request.requirements.commands : [command]
  const executables = commands.flatMap((argv) => {
    const executable = argv[0]
    if (executable === undefined || !isAbsolute(executable)) {
      throw new Error('Sandbox commands require an absolute executable path')
    }
    const resolved = existsSync(executable)
      ? realpathSync(executable)
      : executable
    return resolved === executable ? [executable] : [executable, resolved]
  })
  const executableRules = executables
    .map((path) => `(literal ${quoteScheme(path)})`)
    .join(' ')
  const resourceParentRules = [
    ...new Set(
      [
        ...executables,
        ...request.requirements.readPaths,
        ...request.requirements.writePaths,
        ...(request.requirements.workingDirectory === undefined
          ? []
          : [request.requirements.workingDirectory]),
      ].flatMap(pathAncestors),
    ),
  ]
    .map((path) => `(literal ${quoteScheme(path)})`)
    .join(' ')
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    `(allow process-exec ${executableRules})`,
    ...(resourceParentRules === ''
      ? []
      : [`(allow file-read-metadata ${resourceParentRules})`]),
    '(allow file-read* (literal "/") (subpath "/System") (subpath "/usr/lib") (subpath "/usr/share") (subpath "/private/var/db"))',
    '(allow file-read* (literal "/dev/random") (literal "/dev/urandom"))',
    `(allow file-read* ${executableRules})`,
    ...request.requirements.readPaths.map(
      (path) =>
        `(allow file-read* (literal ${quoteScheme(path)}) (subpath ${quoteScheme(path)}))`,
    ),
    ...request.requirements.writePaths.map(
      (path) =>
        `(allow file-read* file-write* (literal ${quoteScheme(path)}) (subpath ${quoteScheme(path)}))`,
    ),
  ].join('\n')
}

export function buildBubblewrapArgs(
  request: ActionRequest,
  argv: readonly string[],
): string[] {
  const args = ['--unshare-all', '--die-with-parent', '--new-session']
  for (const path of ['/usr', '/bin', '/lib', '/lib64']) {
    if (existsSync(path)) args.push('--ro-bind', path, path)
  }
  args.push('--proc', '/proc', '--dev', '/dev')
  for (const path of request.requirements.readPaths) {
    args.push('--ro-bind', path, path)
  }
  for (const path of request.requirements.writePaths) {
    args.push('--bind', path, path)
  }
  if (request.requirements.workingDirectory !== undefined) {
    args.push('--chdir', request.requirements.workingDirectory)
  }
  args.push('--', ...argv)
  return args
}

export class PlatformCommandSandbox implements SandboxProvider {
  readonly #platform: NodeJS.Platform
  readonly #executable: string | undefined
  #availability: Promise<boolean> | undefined

  constructor(platform: NodeJS.Platform = process.platform) {
    this.#platform = platform
    this.#executable =
      platform === 'darwin'
        ? existsSync('/usr/bin/sandbox-exec')
          ? '/usr/bin/sandbox-exec'
          : undefined
        : platform === 'linux'
          ? ['/usr/bin/bwrap', '/bin/bwrap'].find(existsSync)
          : undefined
  }

  async execute(
    request: ActionRequest,
    options: {
      readonly signal?: AbortSignal | undefined
      readonly secrets: ReadonlyMap<string, string>
    },
  ): Promise<ActionResult> {
    if (!(await this.#available())) {
      throw new SandboxUnavailableError(`platform:${this.#platform}`)
    }
    const sandboxExecutable = this.#executable
    if (sandboxExecutable === undefined) {
      throw new SandboxUnavailableError(`platform:${this.#platform}`)
    }
    if (request.requirements.networkTargets.length > 0) {
      throw new Error(
        'Platform command sandbox does not support network allowlists',
      )
    }
    const env = Object.fromEntries(
      Object.entries(request.requirements.secretEnv).map(([name, ref]) => {
        const value = options.secrets.get(ref)
        if (value === undefined)
          throw new Error(`Secret '${ref}' was not materialized`)
        return [name, value]
      }),
    )
    const results: ProcessResult[] = []
    const timeoutMs = request.requirements.timeoutMs ?? 30_000
    const maxOutputBytes = request.requirements.maxOutputBytes ?? 1_048_576
    const startedAt = Date.now()
    let remainingOutputBytes = maxOutputBytes
    for (const argv of request.requirements.commands) {
      const executable = argv[0]
      if (executable === undefined || !isAbsolute(executable)) {
        throw new Error('Sandbox commands require an absolute executable path')
      }
      const args =
        this.#platform === 'darwin'
          ? ['-p', buildSeatbeltProfile(request, argv), '--', ...argv]
          : buildBubblewrapArgs(request, argv)
      const remainingTimeoutMs = timeoutMs - (Date.now() - startedAt)
      if (remainingTimeoutMs <= 0) throw new SandboxTimeoutError(timeoutMs)
      if (remainingOutputBytes <= 0) {
        throw new SandboxOutputLimitError(maxOutputBytes)
      }
      const result = await runProcess({
        executable: sandboxExecutable,
        args,
        cwd: request.requirements.workingDirectory ?? '/',
        env,
        stdin: request.requirements.commandStdin,
        stdoutCompletion:
          request.requirements.stdoutCompletion?.kind === 'json-line-property'
            ? request.requirements.stdoutCompletion
            : undefined,
        stdioSequence:
          request.requirements.commandStdio?.kind === 'json-lines'
            ? request.requirements.commandStdio
            : undefined,
        signal: options.signal,
        timeoutMs: remainingTimeoutMs,
        maxOutputBytes: remainingOutputBytes,
      })
      remainingOutputBytes -=
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)
      results.push(result)
    }
    const content = results
      .map((result) => {
        if (result.stderr === '') return result.stdout
        if (result.stdout === '') return result.stderr
        const separator = result.stdout.endsWith('\n') ? '' : '\n'
        return `${result.stdout}${separator}[stderr]\n${result.stderr}`
      })
      .join('')
    const failed = results.some(
      (result) => result.exitCode !== 0 && result.completedByOutput !== true,
    )
    return {
      output: { commands: results },
      content,
      ...(failed ? { isError: true } : {}),
      verification: request.verification,
    }
  }

  async snapshot(request: ActionRequest): Promise<WorldSnapshot> {
    const paths = [
      ...request.requirements.readPaths,
      ...request.requirements.writePaths,
    ]
    const state: Record<string, unknown> = {}
    for (const path of paths) {
      try {
        const stat = await lstat(path)
        state[path] = {
          size: stat.size,
          mode: stat.mode,
          modifiedAt: stat.mtime.toISOString(),
          symbolicLink: stat.isSymbolicLink(),
        }
      } catch {
        state[path] = { missing: true }
      }
    }
    return {
      ref: `${this.#platform === 'darwin' ? 'seatbelt' : 'bwrap'}:${request.id}:${Date.now()}`,
      capturedAt: new Date().toISOString(),
      state,
    }
  }

  async diff(before: WorldSnapshot, after: WorldSnapshot): Promise<unknown> {
    return { before: before.state, after: after.state }
  }

  async capabilities(): Promise<SandboxCapabilityReport> {
    const available = await this.#available()
    return {
      provider: this.#platform === 'darwin' ? 'seatbelt' : 'bubblewrap',
      filesystemIsolation: available,
      networkIsolation: false,
      processIsolation: available,
    }
  }

  #available(): Promise<boolean> {
    if (this.#availability !== undefined) return this.#availability
    if (this.#executable === undefined) return Promise.resolve(false)
    const args =
      this.#platform === 'darwin'
        ? ['-p', '(version 1)\n(allow default)', '--', '/usr/bin/true']
        : [
            '--unshare-all',
            '--die-with-parent',
            '--new-session',
            '--ro-bind',
            '/',
            '/',
            '--',
            '/usr/bin/true',
          ]
    this.#availability = runProcess({
      executable: this.#executable,
      args,
      env: {},
      timeoutMs: 2_000,
      maxOutputBytes: 16_384,
    })
      .then((result) => result.exitCode === 0)
      .catch(() => false)
    return this.#availability
  }
}
