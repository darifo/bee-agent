import { z } from 'zod'
import {
  canonicalExistingPath,
  canonicalNativeExecutable,
  canonicalWorkspaceRoot,
  resolveWorkspacePath,
} from '@bee-agent/runtime'
import type {
  LlmToolCall,
  LlmToolSpec,
  ToolAdapter,
  ToolAuthorizationRule,
} from '@bee-agent/runtime'

export const PYTHON_TOOL_ID = 'python_run'

const PYTHON_BOOTSTRAP = [
  'import json, sys',
  'payload = json.load(sys.stdin)',
  'scope = {"args": payload["args"]}',
  'exec(compile(payload["code"], "<bee-python>", "exec"), scope, scope)',
].join('\n')

const PythonInputSchema = z.object({
  code: z.string().min(1).max(1_048_576),
  args: z.unknown().default({}),
  cwd: z.string().min(1).default('.'),
  readPaths: z.array(z.string().min(1)).max(128).default([]),
  writePaths: z.array(z.string().min(1)).max(128).default([]),
  timeoutMs: z.number().int().positive().optional(),
  maxOutputBytes: z.number().int().positive().optional(),
})
export type PythonToolInput = z.infer<typeof PythonInputSchema>

export interface PythonToolOptions {
  readonly workspaceRoot: string
  readonly executable: string
  /** Host-declared read-only roots containing the interpreter runtime/libs. */
  readonly runtimeReadPaths?: readonly string[] | undefined
  readonly secretEnv?: Readonly<Record<string, string>> | undefined
  readonly maxInputBytes?: number | undefined
  readonly maxTimeoutMs?: number | undefined
  readonly maxOutputBytes?: number | undefined
}

/**
 * Declares an isolated one-shot Python action. Process creation and stdin
 * delivery belong exclusively to PlatformCommandSandbox after authorization.
 */
export class PythonToolAdapter implements ToolAdapter {
  readonly #workspaceRoot: string
  readonly #executable: string
  readonly #runtimeReadPaths: readonly string[]
  readonly #secretEnv: Readonly<Record<string, string>>
  readonly #maxInputBytes: number
  readonly #maxTimeoutMs: number
  readonly #maxOutputBytes: number
  readonly spec: LlmToolSpec
  readonly authorization: ToolAuthorizationRule = {
    toolId: PYTHON_TOOL_ID,
    decision: 'ask',
    reason:
      'Python code may read files, write files, and consume local resources',
  }

  constructor(options: PythonToolOptions) {
    this.#workspaceRoot = canonicalWorkspaceRoot(
      options.workspaceRoot,
      'Python workspaceRoot',
    )
    this.#executable = canonicalNativeExecutable(
      options.executable,
      'Python executable',
    )
    this.#runtimeReadPaths = [
      ...new Set(
        (options.runtimeReadPaths ?? []).map((path) =>
          canonicalExistingPath(path, 'Python runtimeReadPath'),
        ),
      ),
    ]
    this.#secretEnv = Object.freeze({ ...(options.secretEnv ?? {}) })
    for (const [name, ref] of Object.entries(this.#secretEnv)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || ref === '') {
        throw new Error('Python secretEnv contains an invalid binding')
      }
    }
    this.#maxInputBytes = options.maxInputBytes ?? 1_048_576
    this.#maxTimeoutMs = options.maxTimeoutMs ?? 30_000
    this.#maxOutputBytes = options.maxOutputBytes ?? 1_048_576
    if (
      this.#maxInputBytes <= 0 ||
      this.#maxTimeoutMs <= 0 ||
      this.#maxOutputBytes <= 0
    ) {
      throw new Error('Python resource limits must be positive')
    }
    this.spec = {
      id: PYTHON_TOOL_ID,
      description:
        'Run one-shot Python code with JSON-compatible args inside the configured workspace sandbox.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['code'],
        properties: {
          code: { type: 'string', maxLength: 1_048_576 },
          args: {
            description:
              'JSON-compatible value exposed to the program as the global variable args.',
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
          },
          writePaths: {
            type: 'array',
            maxItems: 128,
            items: { type: 'string' },
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
    if (call.toolId !== PYTHON_TOOL_ID) {
      throw new Error(`Python adapter cannot describe tool '${call.toolId}'`)
    }
    const input = PythonInputSchema.parse(call.input)
    const commandStdin = JSON.stringify({ code: input.code, args: input.args })
    if (Buffer.byteLength(commandStdin) > this.#maxInputBytes) {
      throw new Error(`Python input exceeds ${this.#maxInputBytes} bytes`)
    }
    const cwd = resolveWorkspacePath(
      this.#workspaceRoot,
      input.cwd,
      'Python cwd',
    )
    const readPaths = [
      cwd,
      ...this.#runtimeReadPaths,
      ...input.readPaths.map((path) =>
        resolveWorkspacePath(this.#workspaceRoot, path, 'Python readPath'),
      ),
    ]
    const writePaths = input.writePaths.map((path) =>
      resolveWorkspacePath(this.#workspaceRoot, path, 'Python writePath'),
    )
    return {
      capability: `tool:${PYTHON_TOOL_ID}`,
      requirements: {
        readPaths: [...new Set(readPaths)],
        writePaths: [...new Set(writePaths)],
        networkTargets: [],
        commands: [[this.#executable, '-I', '-c', PYTHON_BOOTSTRAP]],
        commandStdin,
        secretEnv: { ...this.#secretEnv },
        workingDirectory: cwd,
        timeoutMs: Math.min(
          input.timeoutMs ?? this.#maxTimeoutMs,
          this.#maxTimeoutMs,
        ),
        maxOutputBytes: Math.min(
          input.maxOutputBytes ?? this.#maxOutputBytes,
          this.#maxOutputBytes,
        ),
      },
      expectedEffects: [
        'Execute caller-provided Python code in a fresh isolated interpreter',
        ...writePaths.map((path) => `May modify ${path}`),
      ],
      verification: [
        'Sandbox reports the interpreter exit status and bounded output',
      ],
    }
  }

  async execute(): Promise<never> {
    throw new Error(
      'Python actions must be executed by PlatformCommandSandbox, not in process',
    )
  }
}
