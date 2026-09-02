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

/** One turn's causal trajectory (generations, tools, checkpoints). */
export interface TurnTrajectoryDto {
  readonly threadId: string
  readonly turnId: string
  readonly status: string | undefined
  readonly trigger: string | undefined
  readonly input: string | undefined
  readonly generations: readonly {
    readonly stepIndex: number
    readonly attempt: number
    readonly requestId: string
    readonly model: string
    readonly stopReason: string | undefined
    readonly usage:
      | {
          readonly inputTokens: number
          readonly outputTokens: number
          readonly totalTokens: number
        }
      | undefined
    readonly latencyMs: number | undefined
    readonly error: string | undefined
  }[]
  readonly tools: readonly {
    readonly callId: string
    readonly toolId: string
    readonly capability: string | undefined
    readonly decision: 'allow' | 'ask' | 'deny' | undefined
    readonly decisionReason: string | undefined
    readonly outcome: string
    readonly isError: boolean | undefined
  }[]
  readonly checkpoints: readonly {
    readonly sequence: number
    readonly stepIndex: number
    readonly stateDigest: string
  }[]
}

/** A remembered approval; relaxes ask to allow until revoked. */
export interface GrantDto {
  readonly capability: string
  readonly reason?: string | undefined
  readonly by: string
  readonly at: string
}

/** One thread as the conversation list shows it (`GET /threads`). */
export interface ThreadSummaryDto {
  readonly id: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly turns: number
  readonly lastInput?: string | undefined
  readonly lastOutput?: string | undefined
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

// ---------------------------------------------------------------------------
// Diagnostics, memory governance, learning governance, scheduling (Phase 4/6)
// ---------------------------------------------------------------------------

export interface Diagnostics {
  readonly status: 'ok' | 'degraded'
  readonly structure: {
    readonly activeVersion: string | null
    readonly restartRequired: boolean
    readonly restartRequiredPlugins: readonly string[]
    readonly doctor: unknown
    readonly configSource: unknown
  }
  readonly memory:
    | { readonly enabled: false }
    | {
        readonly enabled: true
        readonly health: { readonly status: string; readonly detail?: string }
        readonly claims: {
          readonly total: number
          readonly active: number
          readonly retracted: number
        }
      }
  readonly world:
    | { readonly enabled: false }
    | {
        readonly enabled: true
        readonly version: number
        readonly entities: number
        readonly relations: number
      }
  readonly scheduler:
    | { readonly enabled: false }
    | { readonly enabled: true; readonly triggers: number }
  readonly learning:
    | { readonly enabled: false }
    | {
        readonly enabled: true
        readonly byStatus: Record<string, number>
        readonly loopBudget: unknown
        readonly driftBudget: unknown
      }
  readonly threads: { readonly streams: number }
}

export interface MemoryClaimDto {
  readonly id: string
  readonly kind: string
  readonly statement: string
  readonly status: string
  readonly autonomyLevel?: number
}

export interface LearningProposalDto {
  readonly id: string
  readonly type: string
  readonly targetKey: string
  readonly hypothesis: string
  readonly status: string
  readonly autonomyLevel: number
  readonly origin: string
  readonly version: number
}

export interface LearningTransitionInput {
  readonly proposalId: string
  readonly to:
    | 'draft'
    | 'testing'
    | 'review'
    | 'trial'
    | 'promoted'
    | 'rejected'
    | 'rolled-back'
  readonly expectedVersion: number
  readonly reason?: string
}

// ---------------------------------------------------------------------------
// Trajectory observability (fast/slow loop timeline)
// ---------------------------------------------------------------------------

/** Foreground fast loop (user-facing turns) vs background slow loop. */
export type TrajectoryLoop = 'fast' | 'slow'

export type TrajectoryCategory =
  'input' | 'llm' | 'tool' | 'memory' | 'reasoning' | 'proposal' | 'system'

export interface TrajectoryEntryDto {
  readonly eventId: string
  readonly streamId: string
  readonly sequence: number
  readonly eventTime: string
  readonly eventType: string
  readonly loop: TrajectoryLoop
  readonly category: TrajectoryCategory
  readonly summary: string
  readonly threadId?: string | undefined
  readonly turnId?: string | undefined
  readonly detail?: Record<string, unknown> | undefined
}

export interface TrajectoryQuery {
  readonly loop?: TrajectoryLoop | undefined
  readonly category?: TrajectoryCategory | undefined
  readonly streamId?: string | undefined
  /** Newest-first page size; default 100, capped at 500. */
  readonly limit?: number | undefined
}

export interface TrajectoryPageDto {
  readonly entries: readonly TrajectoryEntryDto[]
  readonly counts: {
    readonly fast: number
    readonly slow: number
    readonly byCategory: Readonly<Record<TrajectoryCategory, number>>
  }
  readonly scannedStreams: number
}

/** The digest-verified replay of what one model call actually saw. */
export interface ModelReplayDto {
  readonly requestId: string
  readonly manifest: {
    readonly id: string
    readonly promptVersion: string
    readonly structureVersion: string
    readonly tokenBudget: number
    readonly sections: readonly {
      readonly kind: string
      readonly sourceIds: readonly string[]
      readonly rendererVersion: string
      readonly priority: number
      readonly tokens: number
      readonly digest: string
    }[]
    readonly omissions: readonly {
      readonly sourceId: string
      readonly reason: string
    }[]
  }
  readonly bundle: {
    readonly messages: readonly {
      readonly role: string
      readonly content: string
    }[]
    readonly tools?: readonly unknown[] | undefined
    readonly decisionSchema?: Record<string, unknown> | undefined
  }
}

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

  /** Lists every stored thread, newest activity first. */
  listThreads(): Promise<readonly ThreadSummaryDto[]> {
    return this.#request<{ threads: readonly ThreadSummaryDto[] }>(
      'GET',
      'threads',
    ).then((body) => body.threads)
  }

  /** A durable title change; the latest rename wins everywhere. */
  renameThread(threadId: string, title: string): Promise<void> {
    return this.#request<void>(
      'PATCH',
      `threads/${encodeURIComponent(threadId)}/title`,
      { body: { title } },
    )
  }

  /** Stops the thread's in-flight turns; awaiting calls settle cancelled. */
  cancelTurns(threadId: string): Promise<{ cancelled: number }> {
    return this.#request<{ cancelled: number }>(
      'POST',
      `threads/${encodeURIComponent(threadId)}/cancel`,
      { body: {} },
    )
  }

  /** Reads one turn's causal trajectory (WF4-E view). */
  getTurnTrajectory(
    threadId: string,
    turnId: string,
  ): Promise<TurnTrajectoryDto> {
    return this.#request<TurnTrajectoryDto>(
      'GET',
      `threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/trajectory`,
    )
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
    options: { readonly persist?: boolean | undefined } = {},
  ): Promise<TurnResult> {
    return this.#request<TurnResult>(
      'POST',
      `threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/approvals/${encodeURIComponent(approvalId)}`,
      {
        body: {
          decision,
          ...(options.persist === true ? { persist: true } : {}),
        },
      },
    )
  }

  /** Lists the remembered approvals. */
  listGrants(): Promise<readonly GrantDto[]> {
    return this.#request<{ grants: readonly GrantDto[] }>('GET', 'grants').then(
      (body) => body.grants,
    )
  }

  /** Revokes a remembered approval; the tool asks again afterwards. */
  revokeGrant(capability: string): Promise<readonly GrantDto[]> {
    return this.#request<{ grants: readonly GrantDto[] }>(
      'POST',
      `grants/${encodeURIComponent(capability)}/revoke`,
      { body: {} },
    ).then((body) => body.grants)
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

  /** One legal status hop; illegal targets report the legal ones. */
  transitionTask(
    taskId: string,
    to: string,
    reason?: string,
  ): Promise<KanbanTaskDto> {
    return this.#request<KanbanTaskDto>(
      'POST',
      `kanban/tasks/${encodeURIComponent(taskId)}/transition`,
      { body: { to, ...(reason === undefined ? {} : { reason }) } },
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
  /** One-call health overview for `bee doctor`. */
  diagnostics(): Promise<Diagnostics> {
    return this.#request<Diagnostics>('GET', 'diagnostics')
  }

  // --- memory governance -----------------------------------------------

  listMemoryClaims(query: {
    status?: 'active' | 'superseded' | 'retracted'
    kind?: 'preference' | 'fact' | 'correction' | 'procedure'
  }): Promise<readonly MemoryClaimDto[]> {
    const params = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined) as [
        string,
        string,
      ][],
    )
    const suffix = params.size === 0 ? '' : `?${params.toString()}`
    return this.#request<{ claims: readonly MemoryClaimDto[] }>(
      'GET',
      `memory/claims${suffix}`,
    ).then((body) => body.claims)
  }

  forgetMemoryClaim(claimId: string, reason?: string): Promise<MemoryClaimDto> {
    return this.#request<{ claim: MemoryClaimDto }>(
      'POST',
      `memory/claims/${claimId}/retract`,
      { body: reason === undefined ? {} : { reason } },
    ).then((body) => body.claim)
  }

  consolidateMemory(): Promise<unknown> {
    return this.#request<unknown>('POST', 'memory/consolidate', { body: {} })
  }

  // --- learning governance ---------------------------------------------

  runLearningLoop(): Promise<unknown> {
    return this.#request<unknown>('POST', 'learning/run', { body: {} })
  }

  listLearningProposals(query: {
    status?: string
    type?: string
    origin?: 'loop' | 'user'
  }): Promise<readonly LearningProposalDto[]> {
    const params = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined) as [
        string,
        string,
      ][],
    )
    const suffix = params.size === 0 ? '' : `?${params.toString()}`
    return this.#request<{ proposals: readonly LearningProposalDto[] }>(
      'GET',
      `learning/proposals${suffix}`,
    ).then((body) => body.proposals)
  }

  getLearningProposal(proposalId: string): Promise<LearningProposalDto> {
    return this.#request<{ proposal: LearningProposalDto }>(
      'GET',
      `learning/proposals/${proposalId}`,
    ).then((body) => body.proposal)
  }

  runLearningExperiment(proposalId: string): Promise<unknown> {
    return this.#request<{ report: unknown }>(
      'POST',
      `learning/proposals/${proposalId}/experiment`,
      { body: {} },
    ).then((body) => body.report)
  }

  transitionLearningProposal(
    input: LearningTransitionInput,
  ): Promise<LearningProposalDto> {
    return this.#request<{ proposal: LearningProposalDto }>(
      'POST',
      `learning/proposals/${input.proposalId}/transition`,
      {
        body: {
          to: input.to,
          expectedVersion: input.expectedVersion,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
      },
    ).then((body) => body.proposal)
  }

  monitorLearningDrift(): Promise<unknown> {
    return this.#request<unknown>('POST', 'learning/monitor', { body: {} })
  }

  // --- trajectory observability ----------------------------------------

  /** Reads the global fast/slow-loop timeline, newest first. */
  listTrajectory(query: TrajectoryQuery = {}): Promise<TrajectoryPageDto> {
    const params: Record<string, string> = {}
    if (query.loop !== undefined) params.loop = query.loop
    if (query.category !== undefined) params.category = query.category
    if (query.streamId !== undefined) params.streamId = query.streamId
    if (query.limit !== undefined) params.limit = String(query.limit)
    return this.#request<TrajectoryPageDto>('GET', 'trajectory', {
      query: params,
    })
  }

  /** Replays the digest-verified model-visible context of one request. */
  replayModelRequest(requestId: string): Promise<ModelReplayDto> {
    return this.#request<ModelReplayDto>(
      'GET',
      `model-requests/${encodeURIComponent(requestId)}/replay`,
    )
  }

  /** Imports a v0 SQLite event store; `path` must be Host-local absolute. */
  importV0(path: string): Promise<{
    tasksImported: number
    tasksSkipped: number
    eventsRead: number
    eventsImported: number
  }> {
    return this.#request('POST', 'import/v0', { body: { path } })
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
