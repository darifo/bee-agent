import type { AgentLoopRetrieveHook } from './agent-loop.ts'
import type { LlmToolCall, LlmToolSpec } from './llm-runtime.ts'
import type { ToolAdapter, ToolAuthorizationRule } from './tool-execution.ts'

/**
 * Accurate time for the agent (architecture §10 context): models have no
 * clock, so every model request injects the current date-time as a late
 * system message (the system prompt stays a cacheable static prefix), and a
 * built-in `time_now` tool lets the model re-check mid-turn. The service
 * keeps a local clock plus an optional network offset calibrated from HTTP
 * `Date` response headers — a host-owned outbound fetch in the same class
 * as the model provider transport, not an agent effect, so it does not
 * route through ExecutionWorld.
 */

export const DEFAULT_TIME_ZONE = 'Asia/Shanghai'
const DEFAULT_NETWORK_SOURCES = [
  'https://www.baidu.com',
  'https://www.taobao.com',
] as const
const DEFAULT_RECALIBRATE_MS = 3_600_000

export interface TimeServiceOptions {
  /** IANA zone for display; defaults to Asia/Shanghai (UTC+8). */
  readonly timezone?: string | undefined
  /** HTTP endpoints whose `Date` response header calibrates the clock. */
  readonly networkSources?: readonly string[] | undefined
  /** Fetch implementation; defaults to the global fetch. */
  readonly fetch?: typeof fetch | undefined
  /** Periodic recalibration interval; 0 disables the timer. */
  readonly recalibrateMs?: number | undefined
  /** Per-source request timeout; defaults to 5s. */
  readonly sourceTimeoutMs?: number | undefined
}

export interface TimeSnapshot {
  readonly utc: string
  /** `YYYY-MM-DD HH:mm:ss` in the configured timezone. */
  readonly zoned: string
  readonly weekday: string
  readonly timezone: string
  /** Human offset label, e.g. `UTC+8`. */
  readonly utcOffset: string
  readonly networkCalibrated: boolean
  readonly offsetMs: number
  readonly calibratedAt: string | undefined
  readonly source: string | undefined
}

function zonedDateTimeParts(
  date: Date,
  timezone: string,
): {
  zoned: string
  weekday: string
  utcOffset: string
} {
  const dateTimeFormat = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const timeFormat = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const weekdayFormat = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    weekday: 'long',
  })
  const offsetFormat = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    timeZoneName: 'shortOffset',
  })
  const day = dateTimeFormat.format(date)
  const clock = timeFormat.format(date)
  // en-GB renders midnight as "24:00" on some ICU builds; normalize.
  const normalizedClock = clock.startsWith('24:')
    ? `00:${clock.slice(3)}`
    : clock
  const offsetPart =
    offsetFormat
      .formatToParts(date)
      .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+0'
  const utcOffset =
    offsetPart === 'GMT' ? 'UTC+0' : offsetPart.replace('GMT', 'UTC')
  return {
    zoned: `${day} ${normalizedClock}`,
    weekday: weekdayFormat.format(date),
    utcOffset,
  }
}

export class TimeService {
  readonly #timezone: string
  readonly #sources: readonly string[]
  readonly #fetch: typeof fetch
  readonly #sourceTimeoutMs: number
  readonly #recalibrateMs: number
  #offsetMs = 0
  #calibratedAt: string | undefined
  #source: string | undefined
  #timer: ReturnType<typeof setInterval> | undefined

  constructor(options: TimeServiceOptions = {}) {
    this.#timezone = options.timezone ?? DEFAULT_TIME_ZONE
    this.#sources = [...(options.networkSources ?? DEFAULT_NETWORK_SOURCES)]
    this.#fetch = options.fetch ?? fetch.bind(globalThis)
    this.#sourceTimeoutMs = options.sourceTimeoutMs ?? 5_000
    this.#recalibrateMs = options.recalibrateMs ?? DEFAULT_RECALIBRATE_MS
  }

  get timezone(): string {
    return this.#timezone
  }

  /** Network-calibrated now; equals the local clock until calibration ran. */
  now(): Date {
    return new Date(Date.now() + this.#offsetMs)
  }

  snapshot(): TimeSnapshot {
    const now = this.now()
    const { zoned, weekday, utcOffset } = zonedDateTimeParts(
      now,
      this.#timezone,
    )
    return {
      utc: now.toISOString(),
      zoned,
      weekday,
      timezone: this.#timezone,
      utcOffset,
      networkCalibrated: this.#calibratedAt !== undefined,
      offsetMs: this.#offsetMs,
      calibratedAt: this.#calibratedAt,
      source: this.#source,
    }
  }

  /**
   * Reads one HTTP `Date` header per source until one answers; the first
   * successful source wins (second-precision, which is plenty for agent
   * reasoning). Failures keep the previous offset — local clock is the
   * fallback, never a crash.
   */
  async calibrate(): Promise<boolean> {
    for (const source of this.#sources) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(
          () => controller.abort(),
          this.#sourceTimeoutMs,
        )
        const response: Response = await this.#fetch(source, {
          method: 'HEAD',
          signal: controller.signal,
          redirect: 'error',
        })
        clearTimeout(timeout)
        const header = response.headers.get('date')
        if (header === null) continue
        const serverMs = Date.parse(header)
        if (!Number.isFinite(serverMs)) continue
        this.#offsetMs = serverMs - Date.now()
        this.#calibratedAt = new Date().toISOString()
        this.#source = new URL(source).origin
        return true
      } catch {
        // try the next source
      }
    }
    return false
  }

  /** Calibrate once now (best effort) and then on the configured cadence. */
  start(): void {
    void this.calibrate().catch(() => undefined)
    if (this.#recalibrateMs > 0 && this.#timer === undefined) {
      this.#timer = setInterval(() => {
        void this.calibrate().catch(() => undefined)
      }, this.#recalibrateMs)
    }
  }

  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer)
      this.#timer = undefined
    }
  }

  /** The late system message injected into every model request. */
  promptMessage(): string {
    const s = this.snapshot()
    const accuracy = s.networkCalibrated
      ? `network-calibrated against ${s.source} (drift ${s.offsetMs >= 0 ? '+' : ''}${Math.round(s.offsetMs)}ms)`
      : 'host clock, not yet network-calibrated'
    return [
      `Current date-time (${s.timezone}, ${s.utcOffset}) — ${accuracy}:`,
      `- UTC: ${s.utc}`,
      `- ${s.timezone} (${s.utcOffset}): ${s.zoned} (${s.weekday})`,
      'Treat this as "now": use it, not your training cutoff, whenever the answer depends on the current date, weekday, recency, or deadlines.',
    ].join('\n')
  }
}

// ---------------------------------------------------------------------------
// Built-in time_now tool
// ---------------------------------------------------------------------------

export const TIME_NOW_TOOL_ID = 'time_now'

/**
 * The built-in clock tool: read-only, no OS or network effects of its own
 * (calibration is host-owned), so it executes in the in-process sandbox and
 * is always allowed. Parallel-safe — checking the time never contends.
 */
export function createTimeNowTool(time: TimeService): ToolAdapter {
  const spec: LlmToolSpec = {
    id: TIME_NOW_TOOL_ID,
    description:
      'Get the current accurate date-time: UTC, the configured timezone (default Asia/Shanghai, UTC+8), weekday, and whether the clock is network-calibrated.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  }
  const authorization: ToolAuthorizationRule = {
    toolId: TIME_NOW_TOOL_ID,
    decision: 'allow',
    reason: 'Read-only clock lookup with no side effects',
  }
  return {
    spec,
    authorization,
    describe(call: LlmToolCall) {
      if (call.toolId !== TIME_NOW_TOOL_ID) {
        throw new Error(`time tool cannot describe tool '${call.toolId}'`)
      }
      return {
        capability: `tool:${TIME_NOW_TOOL_ID}`,
        requirements: {
          readPaths: [],
          writePaths: [],
          networkTargets: [],
          commands: [],
          secretEnv: {},
        },
        expectedEffects: [],
        verification: ['Snapshot of the host clock is returned'],
      }
    },
    async execute() {
      const s = time.snapshot()
      const content = [
        `UTC: ${s.utc}`,
        `${s.timezone} (${s.utcOffset}): ${s.zoned} (${s.weekday})`,
        s.networkCalibrated
          ? `Calibrated against ${s.source} at ${s.calibratedAt} (drift ${s.offsetMs >= 0 ? '+' : ''}${Math.round(s.offsetMs)}ms)`
          : 'Host clock; not network-calibrated yet',
      ].join('\n')
      return {
        output: s,
        content,
        verification: ['Time snapshot rendered from the calibrated clock'],
      }
    },
    concurrency() {
      return 'parallel' as const
    },
  }
}

/**
 * The per-request time injection: a late system message so the model sees
 * the current date-time on every step without breaking the cacheable
 * static system-prompt prefix.
 */
export function createTimeRetrieveHook(
  time: TimeService,
): AgentLoopRetrieveHook {
  return {
    async retrieve() {
      return [{ role: 'system' as const, content: time.promptMessage() }]
    },
  }
}
