import { spawn } from 'node:child_process'
import type { Tool } from '@bee-agent/runtime'

export const PYTHON_TOOL_ID = 'tools.python'

export class PythonToolError extends Error {
  constructor(
    message: string,
    readonly stderr?: string | undefined,
  ) {
    super(message)
    this.name = 'PythonToolError'
  }
}

export interface PythonToolOptions {
  /** Interpreter to run; defaults to `python3`. */
  readonly command?: string | undefined
  /** Per-call wall-clock limit; defaults to 10 seconds. */
  readonly timeoutMs?: number | undefined
  /** Stdout byte cap; defaults to 1 MiB. */
  readonly maxOutputBytes?: number | undefined
}

export interface PythonToolInput {
  readonly code: string
  /** Exposed to the code as the global `args`. */
  readonly args?: Record<string, unknown>
}

/**
 * Runs Python code in a one-shot child process (ADR 0015): the payload —
 * `{ code, args }` — arrives as JSON on stdin, `stdout` is the output
 * (JSON text is parsed into a structured result), and failures surface as
 * tool errors with the interpreter's stderr. Every call gets a fresh
 * process, so crashes and leaked state cannot spill between calls; this
 * is crash isolation, not a security sandbox — production deployments
 * should run the server itself in a container.
 */
export class PythonTool implements Tool {
  readonly manifest = {
    id: PYTHON_TOOL_ID,
    name: 'Python',
    description:
      'Runs Python code in an isolated one-shot interpreter. The code ' +
      'receives the object `args` and whatever it prints to stdout is the ' +
      'result (print JSON for structured output).',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'Python source to execute, for example "print(args[\'x\'] * 2)"',
        },
        args: {
          type: 'object',
          description: 'JSON object exposed to the code as the global `args`',
        },
      },
      required: ['code'],
    },
  } as const

  readonly #command: string
  readonly #timeoutMs: number
  readonly #maxOutputBytes: number

  constructor(options: PythonToolOptions = {}) {
    this.#command = options.command ?? 'python3'
    this.#timeoutMs = options.timeoutMs ?? 10_000
    this.#maxOutputBytes = options.maxOutputBytes ?? 2 ** 20
  }

  async execute(input: Record<string, unknown>): Promise<unknown> {
    const code = input.code
    if (typeof code !== 'string' || code.trim().length === 0) {
      throw new PythonToolError("input 'code' must be a non-empty string")
    }
    const args =
      typeof input.args === 'object' && input.args !== null ? input.args : {}

    return new Promise<unknown>((resolve, reject) => {
      const child = spawn(this.#command, ['-c', BOOTSTRAP], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let truncated = false
      let settled = false

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(
          new PythonToolError(
            `Python code exceeded the ${this.#timeoutMs}ms limit`,
            stderr,
          ),
        )
      }, this.#timeoutMs)

      function finish(error: PythonToolError | undefined, output?: string) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error !== undefined) {
          reject(error)
          return
        }
        const text = output ?? ''
        try {
          resolve(JSON.parse(text) as unknown)
        } catch {
          resolve(text)
        }
      }

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        if (stdout.length + chunk.length > this.#maxOutputBytes) {
          truncated = true
          child.kill('SIGKILL')
          finish(
            new PythonToolError(
              `Python output exceeded ${this.#maxOutputBytes} bytes`,
              stderr,
            ),
          )
          return
        }
        stdout += chunk
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-2_000)
      })
      child.on('error', (error) => {
        finish(
          new PythonToolError(
            `Failed to run '${this.#command}': ${String(error)}`,
          ),
        )
      })
      child.on('close', (exitCode) => {
        if (truncated) return
        if (exitCode === 0) {
          finish(undefined, stdout)
          return
        }
        const tail = stderr.trim()
        finish(
          new PythonToolError(
            `Python exited with code ${String(exitCode)}${tail.length > 0 ? `: ${tail.split('\n').at(-1) ?? ''}` : ''}`,
            stderr,
          ),
        )
      })

      child.stdin?.on('error', () => {})
      child.stdin?.end(JSON.stringify({ code, args }))
    })
  }
}

/**
 * Wrapper executed by the interpreter: decodes the JSON payload, exposes
 * `args` to the user code, and lets stdout be the output.
 */
const BOOTSTRAP = [
  'import sys, json',
  'try:',
  '    payload = json.loads(sys.stdin.read() or "{}")',
  'except Exception as error:',
  '    sys.stderr.write(f"invalid payload: {error}\\n")',
  '    sys.exit(2)',
  'globals_ = {"args": payload.get("args", {}), "json": json}',
  'exec(compile(payload.get("code", ""), "<task>", "exec"), globals_)',
].join('\n')
