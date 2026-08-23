import { AgentEventSchema } from '@bee-agent/contracts'
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  CreateMemoryDocumentRequest,
  CreateTaskRequest,
  CreateTaskResponse,
  MemoryDocumentResponse,
  MemoryRecallResponse,
} from '@bee-agent/contracts'
import type { TaskSnapshot } from '@bee-agent/runtime'
import { BeeAgentClientError, BeeAgentProtocolError } from './errors.js'
import { parseSseStream } from './sse.js'

export interface BeeAgentClientOptions {
  /** Base URL of the Bee Agent server, for example `http://127.0.0.1:3000`. */
  readonly baseUrl: string | URL
  /** Fetch implementation; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch
  /** Extra headers sent with every request, then every stream. */
  readonly headers?: Readonly<Record<string, string>>
}

export interface StreamEventsOptions {
  /** Resume after this event sequence; sent as `Last-Event-ID`. */
  readonly after?: number
  /** Aborts the stream; the generator then finishes. */
  readonly signal?: AbortSignal
}

/**
 * Client SDK for the Bee Agent server — the only supported way for CLI and
 * Web clients to reach runtime behavior (ADR 0003). Commands go over REST;
 * task events stream over Server-Sent Events.
 */
export class BeeAgentClient {
  readonly #baseUrl: URL
  readonly #fetch: typeof fetch
  readonly #headers: Readonly<Record<string, string>>

  constructor(options: BeeAgentClientOptions) {
    this.#baseUrl = new URL(options.baseUrl.toString())
    if (this.#baseUrl.pathname !== '/' && this.#baseUrl.pathname !== '') {
      this.#baseUrl.pathname = `${this.#baseUrl.pathname.replace(/\/$/, '')}/`
    }
    // Bound so the default works in browsers, where calling the detached
    // global fetch throws "Illegal invocation".
    this.#fetch = options.fetch ?? fetch.bind(globalThis)
    this.#headers = { ...(options.headers ?? {}) }
  }

  get baseUrl(): URL {
    return this.#baseUrl
  }

  /** Creates a pending task. */
  async createTask(request: CreateTaskRequest): Promise<CreateTaskResponse> {
    return this.#request('POST', 'tasks', { body: request })
  }

  /** Rebuilds the task snapshot by replaying its events. */
  async getTask(taskId: string): Promise<TaskSnapshot> {
    return this.#request('GET', `tasks/${encodeURIComponent(taskId)}`)
  }

  /** Snapshots of every task, oldest first. */
  async listTasks(): Promise<TaskSnapshot[]> {
    const payload = await this.#request<{ tasks: TaskSnapshot[] }>(
      'GET',
      'tasks',
    )
    return payload.tasks
  }

  /**
   * Starts a pending task and returns the snapshot after the run began; the
   * task keeps executing on the server. Follow progress with
   * {@link streamEvents} or {@link getTask}.
   */
  async runTask(taskId: string): Promise<TaskSnapshot> {
    return this.#request('POST', `tasks/${encodeURIComponent(taskId)}/run`)
  }

  /** Cancels a pending, running, or suspended task. */
  async cancelTask(taskId: string, reason?: string): Promise<TaskSnapshot> {
    return this.#request('POST', `tasks/${encodeURIComponent(taskId)}/cancel`, {
      body: reason === undefined ? {} : { reason },
    })
  }

  /** Lists recorded task events, optionally after a sequence. */
  async listEvents(taskId: string, after = 0): Promise<AgentEvent[]> {
    const payload = await this.#request<{ events: AgentEvent[] }>(
      'GET',
      `tasks/${encodeURIComponent(taskId)}/events`,
      { query: after > 0 ? { after: String(after) } : undefined },
    )
    return payload.events.map((event) => AgentEventSchema.parse(event))
  }

  /** Lists pending approval requests, optionally scoped to one task. */
  async listPendingApprovals(taskId?: string): Promise<ApprovalRequest[]> {
    const payload = await this.#request<{ approvals: ApprovalRequest[] }>(
      'GET',
      'approvals',
      { query: taskId === undefined ? undefined : { taskId } },
    )
    return payload.approvals
  }

  /** Decides a pending approval request. */
  async resolveApproval(
    requestId: string,
    approved: boolean,
    reason?: string,
  ): Promise<ApprovalDecision> {
    return this.#request(
      'POST',
      `approvals/${encodeURIComponent(requestId)}/decision`,
      {
        body: reason === undefined ? { approved } : { approved, reason },
      },
    )
  }

  /**
   * Stores a document as embedded memory chunks. Requires a server with a
   * Vector Store mounted (`BEE_AGENT_VECTOR_STORE=pgvector`).
   */
  async rememberDocument(
    request: CreateMemoryDocumentRequest,
  ): Promise<MemoryDocumentResponse> {
    return this.#request('POST', 'memory/documents', { body: request })
  }

  /** Semantic recall of the nearest memory chunks, best first. */
  async recallMemory(request: {
    workspaceId: string
    text: string
    limit?: number | undefined
    metadata?: Record<string, unknown> | undefined
  }): Promise<MemoryRecallResponse> {
    return this.#request('POST', 'memory/recall', { body: request })
  }

  /** Drops one memory chunk from its workspace. */
  async forgetMemoryChunk(chunkId: string, workspaceId: string): Promise<void> {
    await this.#request(
      'DELETE',
      `memory/chunks/${encodeURIComponent(chunkId)}`,
      { query: { workspaceId } },
    )
  }

  /**
   * Streams task events over SSE: recorded events after `after` are replayed
   * first, then live events follow. The generator finishes when the stream
   * ends (the server closes it once the task reaches a terminal state) or
   * when `signal` aborts.
   */
  async *streamEvents(
    taskId: string,
    options: StreamEventsOptions = {},
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const url = this.#url(`tasks/${encodeURIComponent(taskId)}/events/stream`)
    const headers: Record<string, string> = {
      ...this.#headers,
      accept: 'text/event-stream',
      'cache-control': 'no-cache',
    }
    if (options.after !== undefined && options.after > 0) {
      headers['last-event-id'] = String(options.after)
    }
    const init: RequestInit = { method: 'GET', headers }
    if (options.signal) init.signal = options.signal
    const response = await this.#fetch(url, init).catch((error: unknown) => {
      if (isAbortError(error, options.signal)) return undefined
      throw error
    })
    if (!response) return
    if (!response.ok) {
      await throwResponseError(response)
    }
    if (!response.body) {
      throw new BeeAgentProtocolError('SSE response has no body')
    }
    try {
      for await (const frame of parseSseStream(response.body)) {
        if (frame.data.length === 0) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(frame.data)
        } catch {
          throw new BeeAgentProtocolError(
            `SSE data is not valid JSON: ${frame.data.slice(0, 120)}`,
          )
        }
        yield AgentEventSchema.parse(parsed)
      }
    } catch (error) {
      if (isAbortError(error, options.signal)) {
        void response.body.cancel().catch(() => undefined)
        return
      }
      throw error
    }
  }

  #url(path: string, query?: Record<string, string>): URL {
    const url = new URL(path, this.#baseUrl)
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value)
      }
    }
    return url
  }

  async #request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown | undefined
      query?: Record<string, string> | undefined
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { ...this.#headers }
    const init: RequestInit = { method, headers }
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(options.body)
    }
    const response = await this.#fetch(this.#url(path, options.query), init)
    if (!response.ok) {
      await throwResponseError(response)
    }
    if (response.status === 204) return undefined as T
    const text = await response.text()
    if (text.length === 0) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new BeeAgentProtocolError(
        `Response from '${path}' is not valid JSON`,
      )
    }
  }
}

function isAbortError(
  error: unknown,
  signal: AbortSignal | undefined,
): boolean {
  if (signal?.aborted) return true
  return error instanceof Error && error.name === 'AbortError'
}

async function throwResponseError(response: Response): Promise<never> {
  const text = await response.text()
  let code = 'unknown'
  let message = text
  let details: Record<string, unknown> | undefined
  try {
    const parsed = JSON.parse(text) as {
      code?: unknown
      message?: unknown
      details?: unknown
    }
    if (typeof parsed.code === 'string') code = parsed.code
    if (typeof parsed.message === 'string') message = parsed.message
    else if (parsed.message !== undefined)
      message = JSON.stringify(parsed.message)
    if (
      parsed.details !== undefined &&
      typeof parsed.details === 'object' &&
      parsed.details !== null
    ) {
      details = parsed.details as Record<string, unknown>
    }
  } catch {
    // keep the raw body as the message
  }
  throw new BeeAgentClientError(
    `Server responded ${response.status} (${code}): ${message}`,
    response.status,
    code,
    details,
  )
}
