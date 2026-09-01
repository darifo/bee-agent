import { describe, expect, it } from 'vitest'
import {
  ChronicleSchemaRegistry,
  registerStructureChronicleEvents,
} from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import { registerThreadChronicleEvents } from '@bee-agent/thread'
import { registerRuntimeChronicleEvents } from '@bee-agent/runtime'
import { registerKanbanChronicleEvents } from '@bee-agent/kanban'
import { createMemoryKanbanStore } from '@bee-agent/kanban/testing'
import type { KanbanStore } from '@bee-agent/kanban'
import { createFakeLlmRuntime } from '@bee-agent/runtime/testing'
import type {
  ActionResult,
  ToolAuthorizationRule,
  ToolExecutionCall,
  ToolExecutor,
} from '@bee-agent/runtime'
import type { FakeLlmStep } from '@bee-agent/runtime/testing'
import { buildBeeServer } from '../src/index.ts'
import type { BeeServer } from '../src/index.ts'

function createRegistryStore(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerStructureChronicleEvents(registry)
  registerThreadChronicleEvents(registry)
  registerRuntimeChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

function createKanbanStore(): KanbanStore {
  const registry = new ChronicleSchemaRegistry()
  registerKanbanChronicleEvents(registry)
  return createMemoryKanbanStore(registry)
}

function scriptedTools(
  handlers: Record<
    string,
    (input: ToolExecutionCall) => ActionResult | Promise<ActionResult>
  >,
): ToolExecutor {
  return {
    describe(call) {
      return {
        capability: `tool:${call.toolId}`,
        requirements: {
          readPaths: [],
          writePaths: [],
          networkTargets: [],
          commands: [],
          secretEnv: {},
        },
        expectedEffects: [
          `Execute tool '${call.toolId}' with input ${JSON.stringify(call.input)}`,
        ],
        verification: ['Tool executor reports completion'],
      }
    },
    async execute(input) {
      const handler = handlers[input.call.toolId] ?? handlers['*']
      if (handler === undefined) {
        return { output: {}, content: 'no handler', verification: [] }
      }
      return handler(input)
    },
  }
}

async function withServer(
  script: readonly FakeLlmStep[],
  toolExecutor: ToolExecutor,
  fn: (server: BeeServer, baseUrl: string) => Promise<void>,
  authorization?: readonly ToolAuthorizationRule[],
): Promise<void> {
  const llm = createFakeLlmRuntime({ script })
  const scriptedToolIds = [
    ...new Set(
      script.flatMap((step) =>
        step.type === 'respond'
          ? (step.toolCalls ?? []).map((call) => call.toolId)
          : [],
      ),
    ),
  ]
  const server = await buildBeeServer({
    store: createRegistryStore(),
    kanban: createKanbanStore(),
    llm,
    toolExecutor,
    toolSpecs: scriptedToolIds.map((id) => ({
      id,
      description: `Test tool ${id}`,
      inputSchema: { type: 'object' },
    })),
    toolAuthorization:
      authorization ??
      script.flatMap((step) =>
        step.type === 'respond'
          ? (step.toolCalls ?? []).map((call) => ({
              toolId: call.toolId,
              decision: 'allow' as const,
              reason: 'Test-declared capability',
            }))
          : [],
      ),
    logger: false,
  })
  await server.app.listen({ host: '127.0.0.1', port: 0 })
  await server.app.ready()
  try {
    const address = server.app.server.address()
    const port =
      address !== null && typeof address === 'object' ? address.port : 0
    await fn(server, `http://127.0.0.1:${port}`)
  } finally {
    await server.app.close()
  }
}

interface SseEvent {
  readonly id: number
  readonly event: string
  readonly data: Record<string, unknown>
}

/**
 * Reads an SSE stream until it sees the terminal event or a short timeout,
 * collecting every event. Used to assert full replay without racing the
 * live-follow tail.
 */
async function readSseUntil(
  target: string,
  lastEventId: number | undefined,
  terminalEvent: string,
  timeoutMs = 2000,
): Promise<SseEvent[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const response = await fetch(target, {
    signal: controller.signal,
    headers:
      lastEventId !== undefined ? { 'Last-Event-ID': String(lastEventId) } : {},
  })
  if (response.body === null) throw new Error('no stream body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events: SseEvent[] = []
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (const event of parseSseBlocks(buffer)) {
        events.push(event)
        if (event.event === terminalEvent) {
          clearTimeout(timeout)
          return events
        }
      }
      buffer = stripCompleteBlocks(buffer)
    }
  } catch {
    // aborted by timeout; return what we collected
  } finally {
    clearTimeout(timeout)
    controller.abort()
    reader.releaseLock()
  }
  return events
}

function parseSseBlocks(chunk: string): SseEvent[] {
  const events: SseEvent[] = []
  let rest = chunk
  let separator = rest.indexOf('\n\n')
  while (separator !== -1) {
    const block = rest.slice(0, separator)
    rest = rest.slice(separator + 2)
    const event = parseSseBlock(block)
    if (event !== undefined) events.push(event)
    separator = rest.indexOf('\n\n')
  }
  return events
}

function stripCompleteBlocks(chunk: string): string {
  const last = chunk.lastIndexOf('\n\n')
  return last === -1 ? chunk : chunk.slice(last + 2)
}

function parseSseBlock(block: string): SseEvent | undefined {
  let id = 0
  let event = 'message'
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('id:')) {
      id = Number(line.slice(3).trim())
    } else if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
    }
  }
  if (dataLines.length === 0) return undefined
  const data = JSON.parse(dataLines.join('\n')) as Record<string, unknown>
  return { id, event, data }
}

describe('apps/bee /threads API', () => {
  it('creates a thread and runs a turn to completion', async () => {
    await withServer(
      [{ type: 'respond', deltas: ['Hello!'] }],
      scriptedTools({}),
      async (_server, baseUrl) => {
        const created = await fetch(`${baseUrl}/threads`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'My thread' }),
        })
        expect(created.status).toBe(201)
        const thread = (await created.json()) as { id: string; title: string }
        expect(thread.title).toBe('My thread')

        const response = await fetch(`${baseUrl}/threads/${thread.id}/turns`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: 'hi' }),
        })
        expect(response.status).toBe(200)
        const result = (await response.json()) as {
          status: string
          output: string
        }
        expect(result.status).toBe('completed')
        expect(result.output).toBe('Hello!')
      },
    )
  })

  it('lists threads with turn counts and newest exchange previews', async () => {
    await withServer(
      [{ type: 'respond', deltas: ['Hello!'] }],
      scriptedTools({}),
      async (_server, baseUrl) => {
        for (const title of ['旧会话', '新会话']) {
          const created = await fetch(`${baseUrl}/threads`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title }),
          })
          expect(created.status).toBe(201)
        }

        const listed = await fetch(`${baseUrl}/threads`)
        expect(listed.status).toBe(200)
        const { threads } = (await listed.json()) as {
          threads: {
            id: string
            title: string
            updatedAt: string
            turns: number
            lastInput?: string
            lastOutput?: string
          }[]
        }
        expect(threads).toHaveLength(2)
        expect(new Set(threads.map((thread) => thread.title))).toEqual(
          new Set(['旧会话', '新会话']),
        )
        // The list is ordered by newest activity.
        const times = threads.map((thread) => thread.updatedAt)
        expect([...times].sort((a, b) => (a < b ? 1 : -1))).toEqual(times)

        const [latest, other] = threads
        const turned = latest!.turns === 1 ? latest! : other!
        const untouched = turned === latest! ? other! : latest!
        expect(untouched.turns).toBe(0)

        const run = await fetch(`${baseUrl}/threads/${turned.id}/turns`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: '你好' }),
        })
        expect(((await run.json()) as { status: string }).status).toBe(
          'completed',
        )

        const relisted = (
          (await (await fetch(`${baseUrl}/threads`)).json()) as {
            threads: typeof threads
          }
        ).threads
        const summary = relisted.find((thread) => thread.id === turned.id)
        expect(summary?.turns).toBe(1)
        expect(summary?.lastInput).toBe('你好')
        expect(summary?.lastOutput).toBe('Hello!')
        expect(relisted[0]!.id).toBe(turned.id)
      },
    )
  })

  it('suspends and resumes a turn on approval', async () => {
    await withServer(
      [
        {
          type: 'respond',
          deltas: ['Deploying…'],
          toolCalls: [{ callId: 'd1', toolId: 'deploy', input: {} }],
        },
        { type: 'respond', deltas: ['Deployed.'] },
      ],
      scriptedTools({
        deploy: () => ({
          output: { ok: true },
          content: 'deployed',
          verification: ['Deployment executor completed'],
        }),
      }),
      async (_server, baseUrl) => {
        const created = await fetch(`${baseUrl}/threads`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
        const thread = (await created.json()) as { id: string }

        const run = await fetch(`${baseUrl}/threads/${thread.id}/turns`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: 'Deploy' }),
        })
        const suspended = (await run.json()) as {
          status: string
          approval: { approvalId: string }
          turn: { id: string }
        }
        expect(suspended.status).toBe('suspended')

        const resume = await fetch(
          `${baseUrl}/threads/${thread.id}/turns/${suspended.turn.id}/approvals/${suspended.approval.approvalId}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ decision: 'approved' }),
          },
        )
        const completed = (await resume.json()) as { status: string }
        expect(completed.status).toBe('completed')
      },
      [
        {
          toolId: 'deploy',
          decision: 'ask',
          reason: 'Production deployment requires user approval',
        },
      ],
    )
  })
})

describe('apps/bee item stream', () => {
  it('replays item events and resumes from Last-Event-ID without loss', async () => {
    await withServer(
      [{ type: 'respond', deltas: ['Streamed answer.'] }],
      scriptedTools({}),
      async (_server, baseUrl) => {
        const created = await fetch(`${baseUrl}/threads`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
        const thread = (await created.json()) as { id: string }

        await fetch(`${baseUrl}/threads/${thread.id}/turns`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: 'first' }),
        })

        // Full replay from the start.
        const all = await readSseUntil(
          `${baseUrl}/threads/${thread.id}/items`,
          undefined,
          'turn.completed',
        )
        expect(all.some((event) => event.event === 'item.started')).toBe(true)
        const completed = all.find((event) => event.event === 'turn.completed')
        expect(completed).toBeDefined()

        // A reconnecting client resumes from a mid-stream sequence and must
        // receive exactly the events after it — none before (duplicates) and
        // none missing (the terminal event is still delivered).
        const midSequence = all.find((event) => event.event === 'item.started')
        const after = midSequence?.id ?? 0
        const tail = await readSseUntil(
          `${baseUrl}/threads/${thread.id}/items`,
          after,
          'turn.completed',
        )
        expect(tail.every((event) => event.id > after)).toBe(true)
        expect(tail.some((event) => event.event === 'turn.completed')).toBe(
          true,
        )
      },
    )
  })
})
