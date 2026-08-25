import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { ThreadEvent, Turn } from '@bee-agent/thread'
import { BeeAgentClient, BeeAgentClientError } from '../src/index.ts'
import { parseSseStream } from '../src/index.ts'

const threadId = randomUUID()
const turnId = randomUUID()

interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: unknown
}

let server: Server
let baseUrl: string
const requests: RecordedRequest[] = []

function threadFixture(): Record<string, unknown> {
  const now = new Date().toISOString()
  return { id: threadId, title: 'My thread', createdAt: now, updatedAt: now }
}

function turnFixture(overrides: Partial<Turn> = {}): Turn {
  return {
    id: turnId,
    threadId,
    status: 'active',
    trigger: 'user',
    startedAt: new Date().toISOString(),
    ...overrides,
  } as Turn
}

function itemStartedEvent(sequence: number): ThreadEvent {
  return {
    sequence,
    threadId,
    turnId,
    event: 'item.started',
    item: {
      id: randomUUID(),
      threadId,
      turnId,
      status: 'active',
      createdAt: new Date().toISOString(),
      type: 'message',
      payload: { role: 'assistant', content: 'hello' },
    },
  }
}

function respond(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const recorded: RecordedRequest = {
        method: request.method ?? '',
        url: request.url ?? '/',
        headers: request.headers,
        body: raw.length > 0 ? JSON.parse(raw) : undefined,
      }
      requests.push(recorded)
      const url = new URL(recorded.url, 'http://localhost')
      const route = `${recorded.method} ${url.pathname}`

      if (route === 'POST /threads') {
        respond(response, 201, threadFixture())
        return
      }
      if (route === `POST /threads/${threadId}/turns`) {
        respond(response, 200, {
          status: 'completed',
          output: 'done',
          turn: turnFixture({ status: 'completed' }),
        })
        return
      }
      if (
        url.pathname ===
        `/threads/${threadId}/turns/${turnId}/approvals/approval-1`
      ) {
        respond(response, 200, {
          status: 'suspended',
          approval: { approvalId: 'approval-1', title: 'Deploy?' },
          turn: turnFixture(),
        })
        return
      }
      if (route === `GET /threads/${threadId}/items`) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(': heartbeat\n\n')
        response.write(
          `id: 1\nevent: thread.created\ndata: ${JSON.stringify({
            sequence: 1,
            threadId,
            event: 'thread.created',
            thread: threadFixture(),
          })}\n\n`,
        )
        response.write(
          `id: 2\nevent: item.started\ndata: ${JSON.stringify(itemStartedEvent(2))}\n\n`,
        )
        setTimeout(() => {
          response.write(
            `id: 3\nevent: turn.completed\ndata: ${JSON.stringify({
              sequence: 3,
              threadId,
              turnId,
              event: 'turn.completed',
              turn: turnFixture({ status: 'completed' }),
            })}\n\n`,
          )
          response.end()
        }, 25)
        return
      }
      if (url.pathname === `/threads/${randomUUID()}/items`) {
        respond(response, 404, { code: 'not-found', message: 'no thread' })
        return
      }
      respond(response, 404, { code: 'not-found', message: 'no route' })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function client(): BeeAgentClient {
  return new BeeAgentClient({ baseUrl })
}

function lastRequest(): RecordedRequest {
  return requests.at(-1)!
}

describe('bee agent client (threads)', () => {
  it('creates a thread over POST /threads', async () => {
    const thread = await client().createThread({ title: 'My thread' })
    expect(thread.id).toBe(threadId)
    expect(thread.title).toBe('My thread')
    expect(lastRequest().method).toBe('POST')
    expect(lastRequest().url).toBe('/threads')
    expect(lastRequest().body).toEqual({ title: 'My thread' })
  })

  it('starts a turn and returns its result', async () => {
    const result = await client().createTurn(threadId, { input: 'hi' })
    expect(result.status).toBe('completed')
    if (result.status === 'completed') {
      expect(result.output).toBe('done')
      expect(result.turn.id).toBe(turnId)
    }
    expect(lastRequest().body).toEqual({ input: 'hi' })
    expect(lastRequest().url).toBe(`/threads/${threadId}/turns`)
  })

  it('resolves an approval for a suspended turn', async () => {
    const result = await client().resolveApproval(
      threadId,
      turnId,
      'approval-1',
      'rejected',
    )
    expect(result.status).toBe('suspended')
    expect(lastRequest().body).toEqual({ decision: 'rejected' })
    expect(lastRequest().url).toBe(
      `/threads/${threadId}/turns/${turnId}/approvals/approval-1`,
    )
  })

  it('sends the session token as a bearer header', async () => {
    const api = new BeeAgentClient({ baseUrl, sessionToken: 'tok-123' })
    await api.createThread()
    expect(lastRequest().headers.authorization).toBe('Bearer tok-123')
  })

  it('maps error envelopes to BeeAgentClientError', async () => {
    const error = (await client()
      .createTurn(randomUUID(), { input: 'x' })
      .catch((reason: unknown) => reason)) as BeeAgentClientError
    expect(error).toBeInstanceOf(BeeAgentClientError)
    expect(error.status).toBe(404)
    expect(error.code).toBe('not-found')
  })
})

describe('bee agent client (item stream)', () => {
  it('streams item events, resumes via Last-Event-ID, and validates them', async () => {
    const api = client()
    const streamed: ThreadEvent[] = []
    for await (const event of api.streamItems(threadId)) {
      streamed.push(event)
    }
    expect(streamed.map((event) => event.event)).toEqual([
      'thread.created',
      'item.started',
      'turn.completed',
    ])
    expect(streamed[1]).toMatchObject({ event: 'item.started', sequence: 2 })
    expect(lastRequest().headers['last-event-id']).toBeUndefined()

    for await (const event of api.streamItems(threadId, { after: 2 })) {
      streamed.push(event)
    }
    expect(lastRequest().headers['last-event-id']).toBe('2')
    expect(streamed.at(-1)?.event).toBe('turn.completed')
  })

  it('stops streaming when the abort signal fires', async () => {
    const controller = new AbortController()
    const api = client()
    const streamed: ThreadEvent[] = []
    for await (const event of api.streamItems(threadId, {
      signal: controller.signal,
    })) {
      streamed.push(event)
      controller.abort()
    }
    expect(streamed.length).toBeGreaterThanOrEqual(1)
    expect(streamed.length).toBeLessThan(3)
  })
})

describe('parseSseStream', () => {
  it('parses multi-line data frames and ignores comments', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            ': ping\n\nid: 7\nevent: item.started\ndata: {"a":1}\ndata: {"b":2}\n\n',
          ),
        )
        controller.close()
      },
    })
    const frames = []
    for await (const frame of parseSseStream(stream)) frames.push(frame)
    expect(frames).toEqual([
      { id: '7', event: 'item.started', data: '{"a":1}\n{"b":2}' },
    ])
  })

  it('handles partial chunk boundaries', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('id: 1\nda'))
        controller.enqueue(encoder.encode('ta: x\n'))
        controller.enqueue(encoder.encode('\nid: 2\ndata: y\n\n'))
        controller.close()
      },
    })
    const frames = []
    for await (const frame of parseSseStream(stream)) frames.push(frame)
    expect(frames).toEqual([
      { id: '1', event: undefined, data: 'x' },
      { id: '2', event: undefined, data: 'y' },
    ])
  })
})
