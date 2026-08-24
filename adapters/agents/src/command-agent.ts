import { spawn } from 'node:child_process'
import { z } from 'zod'
import type { Agent, AgentResult, AgentRunContext } from '@bee-agent/runtime'

export class CommandAgentError extends Error {
  constructor(
    message: string,
    readonly stderr?: string | undefined,
  ) {
    super(message)
    this.name = 'CommandAgentError'
  }
}

export const CommandAgentConfigSchema = z.object({
  /** Agent id this adapter is registered under. */
  id: z.string().min(1),
  /** Executable to run; spawned without a shell. */
  command: z.string().min(1),
  /** Arguments; every `{input}` placeholder is replaced by the task input. */
  args: z.array(z.string()).default([]),
  /** Writes the task input to the program's stdin instead of using args. */
  inputVia: z.enum(['args', 'stdin']).default('args'),
  env: z.record(z.string(), z.string()).optional(),
  /** Wall-clock limit; defaults to 60 seconds. */
  timeoutMs: z.number().int().positive().optional(),
})
export type CommandAgentConfig = z.output<typeof CommandAgentConfigSchema>
/** Constructor input: defaulted fields (`args`, `inputVia`) are optional. */
export type CommandAgentConfigInput = z.input<typeof CommandAgentConfigSchema>

const DEFAULT_TIMEOUT_MS = 60_000
const INPUT_PLACEHOLDER = '{input}'

/**
 * Wraps any command-line program as an agent (ADR 0016): the program runs
 * in a one-shot child process — the task input arrives via a `{input}`
 * argv placeholder or stdin — and everything it prints to stdout becomes
 * the agent's reply. Stderr, non-zero exits, and timeouts fail the run.
 */
export class CommandAgent implements Agent {
  readonly id: string
  readonly #config: CommandAgentConfig

  constructor(config: CommandAgentConfigInput) {
    this.id = config.id
    this.#config = CommandAgentConfigSchema.parse(config)
  }

  async run(context: AgentRunContext): Promise<AgentResult> {
    const timeoutMs = this.#config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const args =
      this.#config.inputVia === 'args'
        ? this.#config.args.map((arg) =>
            arg.split(INPUT_PLACEHOLDER).join(context.input),
          )
        : this.#config.args

    return new Promise<AgentResult>((resolve, reject) => {
      const child = spawn(this.#config.command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.#config.env },
      })
      let stdout = ''
      let stderr = ''
      let settled = false

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(
          new CommandAgentError(
            `Agent '${this.id}' exceeded the ${timeoutMs}ms limit`,
            stderr,
          ),
        )
      }, timeoutMs)

      const finish = (error: CommandAgentError | undefined) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error !== undefined) {
          reject(error)
          return
        }
        resolve({ output: stdout })
      }

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-2_000)
      })
      child.on('error', (error) => {
        finish(
          new CommandAgentError(
            `Failed to run '${this.#config.command}': ${String(error)}`,
          ),
        )
      })
      child.on('close', (exitCode) => {
        if (exitCode === 0) {
          finish(undefined)
          return
        }
        const tail = stderr.trim()
        finish(
          new CommandAgentError(
            `Agent '${this.id}' exited with code ${String(exitCode)}${tail.length > 0 ? `: ${tail.split('\n').at(-1) ?? ''}` : ''}`,
            stderr,
          ),
        )
      })

      child.stdin.on('error', () => {})
      if (this.#config.inputVia === 'stdin') child.stdin.end(context.input)
      else child.stdin.end()
    })
  }
}
