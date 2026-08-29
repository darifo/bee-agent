import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ChronicleSchemaRegistry } from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import { registerContextManifestChronicleEvents } from '@bee-agent/context'
import { registerThreadChronicleEvents } from '@bee-agent/thread'
import { AgentLoop } from '../../src/agent-loop.ts'
import {
  ModelRequestService,
  registerModelRequestChronicleEvents,
} from '../../src/model-request-service.ts'
import { createFakeLlmRuntime } from '../../src/testing.ts'
import type { CapturedLlmCall, FakeLlmStep } from '../../src/testing.ts'
import type { LlmCapabilities } from '../../src/llm-runtime.ts'
import type { ToolExecutionPort } from '../../src/tool-execution.ts'

/**
 * Keyless recorded-session replay (the dsh safety net, adapted): a fixture
 * scripts the model's recorded responses and the tool outcomes, the harness
 * runs the real AgentLoop + ModelRequestService + Chronicle pipeline against
 * them, and the produced durable facts are compared against the recorded
 * expectation — after normalizing run-unique ids and timestamps. Any change
 * to prompt assembly, event protocol, or persistence shows up as a diff.
 *
 * Regenerate expectations after an intentional change:
 *   REPLAY_RECORD=1 pnpm --filter @bee-agent/runtime test
 */

const FIXED_NOW = '2026-01-15T10:00:00.000Z'

// ---------------------------------------------------------------------------
// Fixture shape
// ---------------------------------------------------------------------------

export interface FixtureToolOutcome {
  readonly kind: 'result' | 'approval-required' | 'throw'
  readonly output?: unknown
  readonly content?: string
  readonly isError?: boolean
  readonly approvalId?: string
  readonly title?: string
  readonly detail?: string
  readonly message?: string
}

export type FixtureAction =
  | {
      readonly kind: 'run'
      readonly input: string
      readonly trigger?: 'user' | 'system' | 'schedule'
    }
  | { readonly kind: 'resume'; readonly decision: 'approved' | 'rejected' }
  | { readonly kind: 'recover' }

export interface ReplayFixture {
  readonly name: string
  readonly description: string
  readonly session: {
    readonly llm: {
      readonly script: readonly FakeLlmStep[]
      readonly capabilities?: Partial<LlmCapabilities> | undefined
    }
    readonly tools: Readonly<Record<string, readonly FixtureToolOutcome[]>>
    /** Concurrency declarations, mirroring an adapter's opt-in. */
    readonly toolConcurrency?:
      Readonly<Record<string, 'parallel' | 'exclusive'>> | undefined
    readonly options?:
      | {
          readonly maxSteps?: number | undefined
          readonly maxRetries?: number | undefined
          readonly maxOutputTokens?: number | undefined
          readonly retryDelayMs?: number | undefined
          readonly systemPrompt?: string | undefined
          readonly contextCompaction?:
            | {
                readonly thresholdTokens?: number | undefined
                readonly keepRecentMessages?: number | undefined
                readonly maxAttemptsPerTurn?: number | undefined
                readonly minCoveredMessages?: number | undefined
              }
            | undefined
          readonly toolResultCompaction?:
            | {
                readonly toolResultBudgetTokens?: number | undefined
                readonly keepRecentToolResults?: number | undefined
              }
            | undefined
        }
      | undefined
  }
  readonly actions: readonly FixtureAction[]
  readonly expected?:
    | {
        readonly results: readonly unknown[]
        readonly modelCalls: readonly unknown[]
        readonly streams: readonly {
          readonly streamId: string
          readonly events: readonly unknown[]
        }[]
      }
    | undefined
}

// ---------------------------------------------------------------------------
// Session execution
// ---------------------------------------------------------------------------

function createStore(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerThreadChronicleEvents(registry)
  registerContextManifestChronicleEvents(registry)
  registerModelRequestChronicleEvents(registry)
  return new MemoryChronicleStore(registry, { now: () => FIXED_NOW })
}

function fixtureToolExecution(
  tools: Readonly<Record<string, readonly FixtureToolOutcome[]>>,
  toolConcurrency:
    Readonly<Record<string, 'parallel' | 'exclusive'>> | undefined,
): ToolExecutionPort {
  const queues = new Map(
    Object.entries(tools).map(([toolId, outcomes]) => [toolId, [...outcomes]]),
  )
  return {
    async execute(input) {
      if (input.approval === 'rejected') {
        return {
          kind: 'result',
          result: {
            output: { rejected: true },
            content: 'The user rejected this tool call.',
            isError: true,
            verification: [],
          },
        }
      }
      const outcome = queues.get(input.call.toolId)?.shift()
      if (outcome === undefined) {
        throw new Error(
          `Replay fixture has no outcome scripted for tool '${input.call.toolId}'`,
        )
      }
      if (outcome.kind === 'throw') {
        throw new Error(outcome.message ?? 'scripted tool failure')
      }
      if (outcome.kind === 'approval-required') {
        if (outcome.approvalId === undefined || outcome.title === undefined) {
          throw new Error(
            `Approval outcome for '${input.call.toolId}' needs approvalId and title`,
          )
        }
        return {
          kind: 'approval-required' as const,
          approvalId: outcome.approvalId,
          title: outcome.title,
          detail: outcome.detail ?? outcome.title,
        }
      }
      return {
        kind: 'result',
        result: {
          output: outcome.output ?? {},
          content: outcome.content ?? '',
          isError: outcome.isError,
          verification: [],
        },
      }
    },
    concurrency(call) {
      return toolConcurrency?.[call.toolId] ?? 'exclusive'
    },
  }
}

export interface SessionRecording {
  readonly results: readonly unknown[]
  readonly modelCalls: readonly unknown[]
  readonly streams: readonly {
    readonly streamId: string
    readonly events: readonly unknown[]
  }[]
}

export async function runSession(
  fixture: ReplayFixture,
): Promise<SessionRecording> {
  const store = createStore()
  const llm = createFakeLlmRuntime({
    script: fixture.session.llm.script,
    ...(fixture.session.llm.capabilities === undefined
      ? {}
      : { capabilities: fixture.session.llm.capabilities }),
  })
  const loop = new AgentLoop({
    modelRequests: new ModelRequestService({
      store,
      llm,
      promptVersion: 'replay-prompt@1',
      structureVersion: 'sha256:replay-structure',
    }),
    store,
    toolExecution: fixtureToolExecution(
      fixture.session.tools,
      fixture.session.toolConcurrency,
    ),
    now: () => FIXED_NOW,
    ...(fixture.session.options ?? {}),
  })
  const threadId = crypto.randomUUID()

  const results: unknown[] = []
  let last: Awaited<ReturnType<AgentLoop['runTurn']>> | undefined
  for (const action of fixture.actions) {
    if (action.kind === 'run') {
      last = await loop.runTurn({
        threadId,
        input: action.input,
        ...(action.trigger === undefined ? {} : { trigger: action.trigger }),
      })
    } else if (action.kind === 'resume') {
      if (last?.status !== 'suspended') {
        throw new Error(
          `'resume' action requires a suspended turn, got '${last?.status ?? 'none'}'`,
        )
      }
      last = await loop.resumeTurn({
        threadId,
        turnId: last.turn.id,
        approvalId: last.approval.approvalId,
        decision: action.decision,
      })
    } else {
      if (last === undefined) {
        throw new Error("'recover' action requires a prior turn")
      }
      last = await loop.recoverTurn({ threadId, turnId: last.turn.id })
    }
    results.push(last)
  }

  // The exact model-visible requests, minus the unserializable signal.
  const modelCalls = llm.calls.map((captured: CapturedLlmCall) => ({
    bundle: captured.bundle,
    options:
      captured.options === undefined
        ? undefined
        : { ...captured.options, signal: undefined },
  }))

  const streams: { streamId: string; events: unknown[] }[] = []
  for (const streamId of await store.listStreams()) {
    const events: unknown[] = []
    for await (const event of store.readStream(streamId)) {
      events.push(event)
    }
    streams.push({ streamId, events })
  }
  return { results, modelCalls, streams }
}

// ---------------------------------------------------------------------------
// Normalization and fixture I/O
// ---------------------------------------------------------------------------

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const ISO_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g

/**
 * Replaces run-unique values with stable placeholders so a replay compares
 * equal to its recording: ids map to `<uuid-N>` numbered by first appearance
 * (cross-references stay comparable), timestamps collapse to `<iso>` (their
 * order is already pinned by event order; real clocks have unstable
 * same-millisecond grouping), and undefined-valued properties are dropped to
 * match the JSON serialization the recording round-trips through.
 */
export function normalizeForReplay(value: unknown): unknown {
  const uuids = new Map<string, string>()
  let uuidCount = 0
  const transformString = (text: string): string =>
    text.replace(UUID_PATTERN, (match) => {
      let placeholder = uuids.get(match)
      if (placeholder === undefined) {
        uuidCount += 1
        placeholder = `<uuid-${uuidCount}>`
        uuids.set(match, placeholder)
      }
      return placeholder
    })
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      return transformString(node.replace(ISO_PATTERN, '<iso>'))
    }
    if (Array.isArray(node)) return node.map(walk)
    if (node !== null && typeof node === 'object') {
      const result: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(node)) {
        if (item === undefined) continue
        result[key] = walk(item)
      }
      return result
    }
    return node
  }
  return walk(value)
}

export async function readFixture(path: string): Promise<ReplayFixture> {
  return JSON.parse(await readFile(path, 'utf8')) as ReplayFixture
}

export async function writeRecordedFixture(
  path: string,
  fixture: ReplayFixture,
  recording: SessionRecording,
): Promise<void> {
  const recorded = {
    name: fixture.name,
    description: fixture.description,
    session: fixture.session,
    actions: fixture.actions,
    expected: normalizeForReplay(recording),
  }
  await writeFile(path, `${JSON.stringify(recorded, null, 2)}\n`, 'utf8')
}

export function fixturesDir(): string {
  return join(import.meta.dirname, 'fixtures')
}
