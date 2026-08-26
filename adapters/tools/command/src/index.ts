import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
import { z } from 'zod'
import type {
  LlmToolCall,
  LlmToolSpec,
  ToolAdapter,
  ToolAuthorizationRule,
} from '@bee-agent/runtime'

export const COMMAND_TOOL_ID = 'command_run'

const CommandInputSchema = z.object({
  executable: z.string().min(1),
  arguments: z.array(z.string().max(65_536)).max(256).default([]),
  cwd: z.string().min(1).default('.'),
  readPaths: z.array(z.string().min(1)).max(128).default([]),
  writePaths: z.array(z.string().min(1)).max(128).default([]),
  timeoutMs: z.number().int().positive().optional(),
  maxOutputBytes: z.number().int().positive().optional(),
})
export type CommandToolInput = z.infer<typeof CommandInputSchema>

export interface CommandToolOptions {
  readonly workspaceRoot: string
  readonly allowedExecutables: readonly string[]
  readonly secretEnv?: Readonly<Record<string, string>> | undefined
  readonly maxTimeoutMs?: number | undefined
  readonly maxOutputBytes?: number | undefined
}

function canonicalExistingPath(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`)
  try {
    return realpathSync(path)
  } catch {
    throw new Error(`${label} does not exist`)
  }
}

function canonicalExecutable(path: string): string {
  const executable = canonicalExistingPath(path, 'Command executable')
  const stat = statSync(executable)
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error(`Command executable '${executable}' is not executable`)
  }
  const prefix = Buffer.alloc(2)
  const descriptor = openSync(executable, 'r')
  try {
    readSync(descriptor, prefix, 0, prefix.byteLength, 0)
  } finally {
    closeSync(descriptor)
  }
  if (prefix.toString() === '#!') {
    throw new Error(
      `Command executable '${executable}' is an interpreter script; allow the interpreter and pass this path as an argument`,
    )
  }
  return executable
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    const parent = dirname(path)
    if (parent === path) return path
    return join(canonicalPath(parent), basename(path))
  }
}

function workspacePath(root: string, input: string, label: string): string {
  const candidate = canonicalPath(resolve(root, input))
  const fromRoot = relative(root, candidate)
  if (
    fromRoot === '..' ||
    fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error(`${label} escapes the command workspace`)
  }
  return candidate
}

/**
 * Declares a command action; actual process creation belongs exclusively to
 * PlatformCommandSandbox after authorization.
 */
export class CommandToolAdapter implements ToolAdapter {
  readonly #workspaceRoot: string
  readonly #executables: ReadonlySet<string>
  readonly #secretEnv: Readonly<Record<string, string>>
  readonly #maxTimeoutMs: number
  readonly #maxOutputBytes: number
  readonly spec: LlmToolSpec
  readonly authorization: ToolAuthorizationRule = {
    toolId: COMMAND_TOOL_ID,
    decision: 'ask',
    reason: 'Commands may read files, write files, and create processes',
  }

  constructor(options: CommandToolOptions) {
    this.#workspaceRoot = canonicalExistingPath(
      options.workspaceRoot,
      'Command workspaceRoot',
    )
    if (!statSync(this.#workspaceRoot).isDirectory()) {
      throw new Error('Command workspaceRoot must be a directory')
    }
    const executables = options.allowedExecutables.map((path) =>
      canonicalExecutable(path),
    )
    if (executables.length === 0) {
      throw new Error('Command tool requires at least one allowed executable')
    }
    this.#executables = new Set(executables)
    this.#secretEnv = Object.freeze({ ...(options.secretEnv ?? {}) })
    for (const [name, ref] of Object.entries(this.#secretEnv)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || ref === '') {
        throw new Error('Command secretEnv contains an invalid binding')
      }
    }
    this.#maxTimeoutMs = options.maxTimeoutMs ?? 30_000
    this.#maxOutputBytes = options.maxOutputBytes ?? 1_048_576
    if (this.#maxTimeoutMs <= 0 || this.#maxOutputBytes <= 0) {
      throw new Error('Command resource limits must be positive')
    }
    this.spec = {
      id: COMMAND_TOOL_ID,
      description:
        'Run one pre-approved executable inside the configured workspace sandbox.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['executable'],
        properties: {
          executable: { type: 'string', enum: [...this.#executables] },
          arguments: {
            type: 'array',
            maxItems: 256,
            items: { type: 'string' },
          },
          cwd: {
            type: 'string',
            description: 'Workspace-relative working directory.',
            default: '.',
          },
          readPaths: {
            type: 'array',
            maxItems: 128,
            items: { type: 'string' },
            description: 'Additional workspace-relative readable paths.',
          },
          writePaths: {
            type: 'array',
            maxItems: 128,
            items: { type: 'string' },
            description: 'Workspace-relative writable paths.',
          },
          timeoutMs: {
            type: 'integer',
            minimum: 1,
            maximum: this.#maxTimeoutMs,
          },
          maxOutputBytes: {
            type: 'integer',
            minimum: 1,
            maximum: this.#maxOutputBytes,
          },
        },
      },
    }
  }

  describe(call: LlmToolCall) {
    if (call.toolId !== COMMAND_TOOL_ID) {
      throw new Error(`Command adapter cannot describe tool '${call.toolId}'`)
    }
    const input = CommandInputSchema.parse(call.input)
    const executable = canonicalExecutable(input.executable)
    if (!this.#executables.has(executable)) {
      throw new Error(`Command executable '${executable}' is not allowed`)
    }
    const cwd = workspacePath(this.#workspaceRoot, input.cwd, 'Command cwd')
    const readPaths = [
      cwd,
      ...input.readPaths.map((path) =>
        workspacePath(this.#workspaceRoot, path, 'Command readPath'),
      ),
    ]
    const writePaths = input.writePaths.map((path) =>
      workspacePath(this.#workspaceRoot, path, 'Command writePath'),
    )
    const timeoutMs = Math.min(
      input.timeoutMs ?? this.#maxTimeoutMs,
      this.#maxTimeoutMs,
    )
    const maxOutputBytes = Math.min(
      input.maxOutputBytes ?? this.#maxOutputBytes,
      this.#maxOutputBytes,
    )
    return {
      capability: `tool:${COMMAND_TOOL_ID}`,
      requirements: {
        readPaths: [...new Set(readPaths)],
        writePaths: [...new Set(writePaths)],
        networkTargets: [],
        commands: [[executable, ...input.arguments]],
        secretEnv: { ...this.#secretEnv },
        workingDirectory: cwd,
        timeoutMs,
        maxOutputBytes,
      },
      expectedEffects: [
        `Execute ${JSON.stringify([executable, ...input.arguments])}`,
        ...writePaths.map((path) => `May modify ${path}`),
      ],
      verification: [
        'Sandbox reports the command exit status and bounded output',
      ],
    }
  }

  async execute(): Promise<never> {
    throw new Error(
      'Command actions must be executed by PlatformCommandSandbox, not in process',
    )
  }
}
