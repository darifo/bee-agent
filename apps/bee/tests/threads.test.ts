import { describe, expect, it } from 'vitest'
import { ChronicleSchemaRegistry } from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import { registerThreadChronicleEvents } from '@bee-agent/thread'
import { createFakeLlmRuntime } from '@bee-agent/runtime/testing'
import type {
  AgentLoopToolOutcome,
  AgentLoopToolSlot,
  AgentLoopToolSlotCall,
} from '@bee-agent/runtime'
import type { FakeLlmStep } from '@bee-agent/runtime/testing'
import { buildBeeServer } from '../src/index.js'
import type { BeeServer } from '../src/index.js'

function createRegistryStore(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerThreadChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

function scriptedTools(
  handlers: Record<
    string,
    (
      input: AgentLoopToolSlotCall,
    ) => AgentLoopToolOutcome | Promise<AgentLoopToolOutcome>
  >,
): AgentLoopToolSlot {
  return {
    async execute(input) {
      const handler = handlers[input.call.toolId] ?? handlers['*']
      if (handler === undefined) {
        return { kind: 'result', output: {}, content: 'no handler' }
      }
      return handler(input)
    },
  }
}

async function withServer(
  script: readonly FakeLlmStep[],
  tools: AgentLoopToolSlot,
  fn: (server: BeeServer, baseUrl: string) => Promise<void>,
): Promise<void> {
  const llm = createFakeLlmRuntime({ script })
  const server = await buildBeeServer({
    store: createRegistryStore(),
    llm,
    tools,
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
        deploy: (input) =>
          input.approval === 'approved'
            ? { kind: 'result', output: { ok: true }, content: 'deployed' }
            : {
                kind: 'approval-required',
                approvalId: 'approval-1',
                title: 'Deploy to prod?',
              },
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
        expect(suspended.approval.approvalId).toBe('approval-1')

        const resume = await fetch(
          `${baseUrl}/threads/${thread.id}/turns/${suspended.turn.id}/approvals/approval-1`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ decision: 'approved' }),
          },
        )
        const completed = (await resume.json()) as { status: string }
        expect(completed.status).toBe('completed')
      },
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
