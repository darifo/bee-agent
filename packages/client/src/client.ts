import { ThreadEventSchema, ThreadSchema } from '@bee-agent/thread/protocol'
import type {
  Thread,
  ThreadEvent,
  ThreadId,
  Turn,
  TurnId,
} from '@bee-agent/thread/protocol'
import { BeeAgentClientError, BeeAgentProtocolError } from './errors.ts'
import { parseSseStream } from './sse.ts'

export type ApprovalDecision = 'approved' | 'rejected'

/** The result of creating or resuming a turn, mirroring the server loop. */
export type TurnResult =
  | {
      readonly status: 'completed'
      readonly output: string
      readonly turn: Turn
    }
  | { readonly status: 'failed'; readonly error: string; readonly turn: Turn }
  | { readonly status: 'cancelled'; readonly turn: Turn }
  | {
      readonly status: 'suspended'
      readonly approval: { readonly approvalId: string; readonly title: string }
      readonly turn: Turn
    }

export interface CreateThreadInput {
  readonly title?: string | undefined
  readonly workspaceId?: string | undefined
  readonly memoryView?:
    { readonly id: string; readonly version: string } | undefined
}

export interface CreateTurnInput {
  readonly input: string
  readonly structureVersion?: string | undefined
}

/** A kanban task as returned by the host's `/kanban/tasks` endpoints. */
export interface KanbanTaskDto {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly priority: string
  readonly labels: readonly string[]
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly goal?: string | undefined
  readonly comments: readonly KanbanCommentDto[]
}

export interface KanbanCommentDto {
  readonly id: string
  readonly author: string
  readonly body: string
  readonly at: string
}

export interface CreateTaskInput {
  readonly title: string
  readonly priority?: string | undefined
  readonly goal?: string | undefined
  readonly acceptanceCriteria?: readonly string[] | undefined
  readonly labels?: readonly string[] | undefined
  readonly deadline?: string | undefined
  readonly scheduledAt?: string | undefined
}

export interface ListTasksQuery {
  readonly status?: string | undefined
  readonly priority?: string | undefined
  readonly labels?: readonly string[] | undefined
  readonly limit?: number | undefined
}

export interface UpdateTaskInput {
  readonly title?: string | undefined
  readonly goal?: string | undefined
  readonly priority?: string | undefined
  readonly labels?: readonly string[] | undefined
  readonly deadline?: string | undefined
  readonly scheduledAt?: string | undefined
}

export interface StreamItemsOptions {
  /** Resume after this event sequence; sent as `Last-Event-ID`. */
  readonly after?: number | undefined
  /** Aborts the stream; the generator then finishes. */
  readonly signal?: AbortSignal | undefined
}

export interface BeeAgentClientOptions {
  /** Base URL of the host, for example `http://127.0.0.1:3000`. */
  readonly baseUrl: string | URL
  /** Fetch implementation; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch
  /** Extra headers sent with every request and stream. */
  readonly headers?: Readonly<Record<string, string>>
  /** One-time session token; sent as `Authorization: Bearer <token>`. */
  readonly sessionToken?: string | undefined
}

/**
 * Client SDK for the Personal Bee Host. Threads and turns go over REST; the
 * turn's item events stream over Server-Sent Events with `Last-Event-ID`
 * recovery (architecture §9.1, §16.4).
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
    this.#headers = {
      ...(options.headers ?? {}),
      ...(options.sessionToken !== undefined
        ? { authorization: `Bearer ${options.sessionToken}` }
        : {}),
    }
  }

  get baseUrl(): URL {
    return this.#baseUrl
  }

  /** Creates a thread and returns the server-stored record. */
  async createThread(input: CreateThreadInput = {}): Promise<Thread> {
    const payload = await this.#request<Thread>('POST', 'threads', {
      body: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.workspaceId !== undefined
          ? { workspaceId: input.workspaceId }
          : {}),
        ...(input.memoryView !== undefined
          ? { memoryView: input.memoryView }
          : {}),
      },
    })
    return ThreadSchema.parse(payload)
  }

  /** Starts a turn on a thread; the server keeps running it to completion. */
  async createTurn(
    threadId: ThreadId,
    input: CreateTurnInput,
  ): Promise<TurnResult> {
    return this.#request<TurnResult>(
      'POST',
      `threads/${encodeURIComponent(threadId)}/turns`,
      {
        body: {
          input: input.input,
          ...(input.structureVersion !== undefined
            ? { structureVersion: input.structureVersion }
            : {}),
        },
      },
    )
  }

  /** Decides a suspended turn's approval and resumes it. */
  async resolveApproval(
    threadId: ThreadId,
    turnId: TurnId,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<TurnResult> {
    return this.#request<TurnResult>(
      'POST',
      `threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/approvals/${encodeURIComponent(approvalId)}`,
      { body: { decision } },
    )
  }

  // -------------------------------------------------------------------------
  // Kanban (same store the agent tools and Scheduler share)
  // -------------------------------------------------------------------------

  async createTask(input: CreateTaskInput): Promise<KanbanTaskDto> {
    return this.#request<KanbanTaskDto>('POST', 'kanban/tasks', { body: input })
  }

  async listTasks(query: ListTasksQuery = {}): Promise<KanbanTaskDto[]> {
    const params: Record<string, string> = {}
    if (query.status !== undefined) params.status = query.status
    if (query.priority !== undefined) params.priority = query.priority
    if (query.labels !== undefined && query.labels.length > 0) {
      params.labels = query.labels.join(',')
    }
    if (query.limit !== undefined) params.limit = String(query.limit)
    return this.#request<KanbanTaskDto[]>('GET', 'kanban/tasks', {
      query: params,
    })
  }

  async getTask(taskId: string): Promise<KanbanTaskDto> {
    return this.#request<KanbanTaskDto>(
      'GET',
      `kanban/tasks/${encodeURIComponent(taskId)}`,
    )
  }

  async updateTask(
    taskId: string,
    input: UpdateTaskInput,
  ): Promise<KanbanTaskDto> {
    return this.#request<KanbanTaskDto>(
      'PATCH',
      `kanban/tasks/${encodeURIComponent(taskId)}`,
      { body: input },
    )
  }

  async blockTask(taskId: string, reason?: string): Promise<KanbanTaskDto> {
    return this.#request<KanbanTaskDto>(
      'POST',
      `kanban/tasks/${encodeURIComponent(taskId)}/block`,
      { body: reason !== undefined ? { reason } : {} },
    )
  }

  async commentTask(
    taskId: string,
    body: string,
    author?: string,
  ): Promise<KanbanTaskDto> {
    return this.#request<KanbanTaskDto>(
      'POST',
      `kanban/tasks/${encodeURIComponent(taskId)}/comment`,
      { body: { body, ...(author !== undefined ? { author } : {}) } },
    )
  }

  async completeTask(taskId: string): Promise<KanbanTaskDto> {
    return this.#request<KanbanTaskDto>(
      'POST',
      `kanban/tasks/${encodeURIComponent(taskId)}/complete`,
      { body: {} },
    )
  }

  async cancelTask(taskId: string): Promise<KanbanTaskDto> {
    return this.#request<KanbanTaskDto>(
      'POST',
      `kanban/tasks/${encodeURIComponent(taskId)}/cancel`,
      { body: {} },
    )
  }

  /**
   * Streams a thread's wire events over SSE. Recorded events after `after`
   * are replayed first, then live events follow; the generator finishes when
   * the stream ends or `signal` aborts. Every frame is validated against the
   * ThreadEvent protocol before it is yielded.
   */
  async *streamItems(
    threadId: ThreadId,
    options: StreamItemsOptions = {},
  ): AsyncGenerator<ThreadEvent, void, unknown> {
    const url = this.#url(`threads/${encodeURIComponent(threadId)}/items`)
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
        yield ThreadEventSchema.parse(parsed)
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
