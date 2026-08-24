/**
 * Deterministic test baseline (v1 refactor plan §4.2).
 *
 * Injection convention: production code receives time through a `Clock` and
 * model/tool behavior through their service contracts; tests inject the fakes
 * from this module so time, model output, and tool behavior are fully
 * scripted and replayable. Production code must never construct these fakes.
 *
 * `createScriptedModel` is provisional: it models decisions as plain steps
 * until the `LLMRuntime` contract lands in Phase 1 (task P1-9), at which
 * point the fake conforms to that contract.
 */

/** Time source injectable into production code. */
export interface Clock {
  epochMs(): number
  now(): Date
}

interface ScheduledTimer {
  id: number
  at: number
  run: () => void
  canceled: boolean
}

/**
 * Manually advanced clock with a deterministic timer queue: `schedule`
 * behaves like `setTimeout`, `advance` fires due timers in (time, id) order —
 * including timers scheduled while advancing — and never lets wall-clock
 * time leak in.
 */
export class FakeClock implements Clock {
  readonly #timers: ScheduledTimer[] = []
  #epochMs: number
  #nextTimerId = 1

  constructor(startEpochMs = 0) {
    this.#epochMs = startEpochMs
  }

  epochMs(): number {
    return this.#epochMs
  }

  now(): Date {
    return new Date(this.#epochMs)
  }

  schedule(delayMs: number, run: () => void): () => void {
    const timer: ScheduledTimer = {
      id: this.#nextTimerId,
      at: this.#epochMs + delayMs,
      run,
      canceled: false,
    }
    this.#nextTimerId += 1
    this.#timers.push(timer)
    return () => {
      timer.canceled = true
    }
  }

  pendingTimerCount(): number {
    return this.#timers.filter((timer) => !timer.canceled).length
  }

  advance(ms: number): void {
    if (ms < 0) throw new RangeError('FakeClock cannot advance backwards')
    const target = this.#epochMs + ms
    for (;;) {
      const due = this.#timers
        .filter((timer) => !timer.canceled && timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)
      const next = due[0]
      if (next === undefined) break
      this.#timers.splice(this.#timers.indexOf(next), 1)
      this.#epochMs = next.at
      next.run()
    }
    this.#epochMs = Math.max(this.#epochMs, target)
  }
}

/** Invocation record kept by every fake tool for assertions. */
export interface FakeToolCall {
  readonly input: Record<string, unknown>
  readonly context: unknown
}

/**
 * Scriptable tool with the manifest/execute shape used by the v0 registry.
 * The Phase 2/3 tasks replace the local types with the official capability
 * contracts; the recording behavior is what tests rely on.
 */
export interface FakeTool {
  readonly manifest: {
    readonly id: string
    readonly name: string
    readonly description: string
    readonly inputSchema: Record<string, unknown>
  }
  readonly calls: readonly FakeToolCall[]
  execute(
    input: Record<string, unknown>,
    context: unknown,
  ): unknown | Promise<unknown>
}

export function createFakeTool(options: {
  id?: string
  description?: string
  handler?: (
    input: Record<string, unknown>,
    context: unknown,
  ) => unknown | Promise<unknown>
} = {}): FakeTool {
  const id = options.id ?? 'tools.fake'
  const calls: FakeToolCall[] = []
  return {
    manifest: {
      id,
      name: id,
      description: options.description ?? `fake tool ${id}`,
      inputSchema: { type: 'object' },
    },
    get calls() {
      return calls
    },
    async execute(input, context) {
      calls.push({ input, context })
      if (options.handler === undefined) return input
      return options.handler(input, context)
    },
  }
}

/**
 * One scripted model decision. `text` is assistant output, `tool-call`
 * requests a tool, `error` fails the step.
 */
export type ScriptedModelStep =
  | { readonly kind: 'text'; readonly content: string }
  | {
      readonly kind: 'tool-call'
      readonly toolId: string
      readonly input: Record<string, unknown>
    }
  | { readonly kind: 'error'; readonly error: Error }

export interface ScriptedModel {
  /** Issues the next scripted decision; rejects when the script runs dry. */
  respond(request: unknown): Promise<ScriptedModelStep>
  /** Every decision issued so far, in order. */
  readonly issued: readonly ScriptedModelStep[]
}

/**
 * Deterministic model double: pops one step per call in script order. Unlike
 * `MockAgent` it owns no conversation state — the caller (the future
 * `AgentLoop`) decides what a decision means.
 */
export function createScriptedModel(
  steps: readonly ScriptedModelStep[],
): ScriptedModel {
  const script = [...steps]
  const issued: ScriptedModelStep[] = []
  return {
    get issued() {
      return issued
    },
    async respond() {
      const step = script.shift()
      if (step === undefined) {
        throw new Error('Scripted model ran out of steps')
      }
      issued.push(step)
      if (step.kind === 'error') throw step.error
      return step
    },
  }
}
