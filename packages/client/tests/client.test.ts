import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { AgentEventSchema } from '@bee-agent/contracts'
import type { AgentEvent } from '@bee-agent/contracts'
import { BeeAgentClient, BeeAgentClientError } from '../src/index.js'
import { parseSseStream } from '../src/index.js'

const taskId = randomUUID()

interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: unknown
}

let server: Server
let baseUrl: string
const requests: RecordedRequest[] = []

function eventFixture(sequence: number, type: string): AgentEvent {
  return AgentEventSchema.parse({
    taskId,
    sequence,
    type,
    payload: { state: 'pending' },
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  })
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
      if (route === 'GET /tasks') {
        respond(response, 200, {
          tasks: [{ taskId, state: 'pending', lastSequence: 1 }],
        })
        return
      }
      if (route === 'POST /tasks') {
        respond(response, 201, {
          task: { ...(recorded.body as Record<string, unknown>), id: taskId },
          state: 'pending',
        })
        return
      }
      if (url.pathname === '/tasks/error') {
        respond(response, 409, {
          code: 'task-not-runnable',
          message: 'only pending tasks',
          details: { state: 'completed' },
        })
        return
      }
      if (route === `GET /tasks/${taskId}`) {
        respond(response, 200, { taskId, state: 'pending', lastSequence: 1 })
        return
      }
      if (route === `POST /tasks/${taskId}/run`) {
        respond(response, 202, { taskId, state: 'running', lastSequence: 2 })
        return
      }
      if (route === `POST /tasks/${taskId}/cancel`) {
        respond(response, 200, { taskId, state: 'cancelled', lastSequence: 3 })
        return
      }
      if (route === `GET /tasks/${taskId}/events`) {
        const after = Number(url.searchParams.get('after') ?? '0')
        respond(response, 200, {
          events: [eventFixture(after + 1, 'task.created')],
        })
        return
      }
      if (route === 'GET /approvals') {
        respond(response, 200, { approvals: [] })
        return
      }
      if (
        url.pathname.startsWith('/approvals/') &&
        url.pathname.endsWith('/decision')
      ) {
        respond(response, 200, {
          requestId: 'req-1',
          approved: (recorded.body as { approved: boolean }).approved,
          decidedAt: new Date().toISOString(),
        })
        return
      }
      if (route === `GET /tasks/${taskId}/events/stream`) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const first = eventFixture(1, 'task.created')
        const second = eventFixture(2, 'task.started')
        response.write(': heartbeat\n\n')
        response.write(
          `id: 1\nevent: task.created\ndata: ${JSON.stringify(first)}\n\n`,
        )
        response.write(
          `id: 2\nevent: task.started\ndata: ${JSON.stringify(second)}\n\n`,
        )
        setTimeout(() => {
          response.write(
            `id: 3\nevent: task.completed\ndata: ${JSON.stringify(
              eventFixture(3, 'task.completed'),
            )}\n\n`,
          )
          response.end()
        }, 25)
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

describe('bee agent client', () => {
  it('creates tasks over POST /tasks', async () => {
    const response = await client().createTask({
      input: 'hello',
      agentId: 'agent.mock',
      metadata: {},
    })
    expect(response.task.id).toBe(taskId)
    expect(response.state).toBe('pending')
    expect(lastRequest().body).toEqual({
      input: 'hello',
      agentId: 'agent.mock',
      metadata: {},
    })
  })

  it('reads snapshots, runs, and cancels tasks', async () => {
    const api = client()
    expect((await api.getTask(taskId)).state).toBe('pending')
    expect((await api.runTask(taskId)).state).toBe('running')
    expect((await api.cancelTask(taskId, 'stop')).state).toBe('cancelled')
    expect(lastRequest().body).toEqual({ reason: 'stop' })
  })

  it('lists task snapshots', async () => {
    const tasks = await client().listTasks()
    expect(tasks).toEqual([{ taskId, state: 'pending', lastSequence: 1 }])
    expect(lastRequest().url).toBe('/tasks')
  })

  it('lists events with an after query and validates them', async () => {
    const events = await client().listEvents(taskId, 4)
    expect(events).toHaveLength(1)
    expect(events[0]!.sequence).toBe(5)
    expect(lastRequest().url).toContain('after=4')
  })

  it('lists approvals and posts decisions', async () => {
    const api = client()
    await api.listPendingApprovals(taskId)
    expect(lastRequest().url).toContain(`taskId=${taskId}`)
    const decision = await api.resolveApproval('req-1', true, 'looks fine')
    expect(decision.approved).toBe(true)
    expect(lastRequest().body).toEqual({ approved: true, reason: 'looks fine' })
  })

  it('maps error envelopes to BeeAgentClientError', async () => {
    await expect(client().getTask('error')).rejects.toBeInstanceOf(
      BeeAgentClientError,
    )
    const error = (await client()
      .getTask('error')
      .catch((reason: unknown) => reason)) as BeeAgentClientError
    expect(error.status).toBe(409)
    expect(error.code).toBe('task-not-runnable')
    expect(error.details).toEqual({ state: 'completed' })
  })

  it('streams SSE events, resumes via Last-Event-ID, and finishes at stream end', async () => {
    const api = client()
    const streamed: AgentEvent[] = []
    for await (const event of api.streamEvents(taskId)) {
      streamed.push(event)
    }
    expect(streamed.map((event) => event.type)).toEqual([
      'task.created',
      'task.started',
      'task.completed',
    ])
    expect(lastRequest().headers['last-event-id']).toBeUndefined()
    for await (const event of api.streamEvents(taskId, { after: 2 })) {
      streamed.push(event)
    }
    expect(lastRequest().headers['last-event-id']).toBe('2')
    expect(streamed.at(-1)!.type).toBe('task.completed')
  })

  it('stops streaming when the abort signal fires', async () => {
    const controller = new AbortController()
    const api = client()
    const streamed: AgentEvent[] = []
    for await (const event of api.streamEvents(taskId, {
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
            ': ping\n\nid: 7\nevent: task.created\ndata: {"a":1}\ndata: {"b":2}\n\n',
          ),
        )
        controller.close()
      },
    })
    const frames = []
    for await (const frame of parseSseStream(stream)) frames.push(frame)
    expect(frames).toEqual([
      { id: '7', event: 'task.created', data: '{"a":1}\n{"b":2}' },
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
