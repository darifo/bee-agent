import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import { CreateTaskRequestSchema } from '@bee-agent/contracts'
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  CreateTaskRequest,
  TaskSpec,
  ToolCall,
  ToolResult,
} from '@bee-agent/contracts'
import type { EventStore } from '@bee-agent/event-store'
import { defineSerialEvent, eventStoreService } from '@bee-agent/kernel'
import type { Kernel, TaskScope } from '@bee-agent/kernel'
import type { Agent, AgentRunContext } from './agent.js'
import { TaskCancelledError } from './agent.js'
import {
  AgentMessagePayloadSchema,
  ApprovalDecidedPayloadSchema,
  ApprovalRequestedPayloadSchema,
  RESERVED_EVENT_TYPES,
  TaskCancelledPayloadSchema,
  TaskCompletedPayloadSchema,
  TaskCreatedPayloadSchema,
  TaskFailedPayloadSchema,
  TaskResumedPayloadSchema,
  TaskStartedPayloadSchema,
  TaskSuspendedPayloadSchema,
  ToolCallPayloadSchema,
  ToolResultPayloadSchema,
  applyTaskEvent,
  reduceTaskSnapshot,
} from './task-events.js'
import type { TaskLifecycleEventType, TaskSnapshot } from './task-events.js'
import {
  assertTaskTransition,
  isTerminalTaskState,
} from './task-state-machine.js'
import { PolicyEngine, toolPolicyMiddleware } from './policy.js'
import type { ToolPolicy } from './policy.js'
import { ToolRegistry, toolExecuteEvent } from './tool.js'
import type { ApprovalRequestInput, Tool, ToolExecutionHooks } from './tool.js'

/**
 * Serial kernel event dispatched after every task event the runtime appended
 * to the Event Store. Subscribe through `kernel.events` for observability.
 */
export const taskEventRecordedEvent = defineSerialEvent<{
  readonly event: AgentEvent
}>('task/event-recorded')

const EVENT_PAYLOAD_SCHEMAS = {
  'task.created': TaskCreatedPayloadSchema,
  'task.started': TaskStartedPayloadSchema,
  'task.suspended': TaskSuspendedPayloadSchema,
  'task.resumed': TaskResumedPayloadSchema,
  'task.completed': TaskCompletedPayloadSchema,
  'task.failed': TaskFailedPayloadSchema,
  'task.cancelled': TaskCancelledPayloadSchema,
  'agent.message': AgentMessagePayloadSchema,
  'tool.call': ToolCallPayloadSchema,
  'tool.result': ToolResultPayloadSchema,
  'approval.requested': ApprovalRequestedPayloadSchema,
  'approval.decided': ApprovalDecidedPayloadSchema,
} as const
type KnownEventName = keyof typeof EVENT_PAYLOAD_SCHEMAS
type KnownEventPayloadMap = {
  [K in KnownEventName]: z.infer<(typeof EVENT_PAYLOAD_SCHEMAS)[K]>
}
type LifecyclePayloadMap = {
  [K in TaskLifecycleEventType]: KnownEventPayloadMap[K]
}

export class TaskRuntimeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskRuntimeError'
  }
}

export class UnknownTaskError extends TaskRuntimeError {
  constructor(readonly taskId: string) {
    super(`Unknown task '${taskId}'`)
    this.name = 'UnknownTaskError'
  }
}

export class UnknownAgentError extends TaskRuntimeError {
  constructor(readonly agentId: string) {
    super(
      `Unknown agent '${agentId}'; register it on the task runtime or provide a default agent`,
    )
    this.name = 'UnknownAgentError'
  }
}

export class InvalidTaskStateError extends TaskRuntimeError {
  constructor(
    readonly taskId: string,
    readonly operation: string,
    readonly state: string,
    detail?: string,
  ) {
    super(
      `Cannot ${operation} task '${taskId}' in state '${state}'` +
        (detail === undefined ? '' : `: ${detail}`),
    )
    this.name = 'InvalidTaskStateError'
  }
}

export class TaskAlreadyActiveError extends TaskRuntimeError {
  constructor(readonly taskId: string) {
    super(`Task '${taskId}' is already running`)
    this.name = 'TaskAlreadyActiveError'
  }
}

export class UnknownApprovalRequestError extends TaskRuntimeError {
  constructor(readonly requestId: string) {
    super(`No pending approval request '${requestId}'`)
    this.name = 'UnknownApprovalRequestError'
  }
}

export interface TaskRuntimeOptions {
  /** Agents keyed by the `agentId` a task spec references. */
  readonly agents?: Readonly<Record<string, Agent>>
  /** Agent used when `agentId` is not registered; `undefined` disables it. */
  readonly defaultAgent?: Agent | undefined
  /** Tools seeded into the global tool registry. */
  readonly tools?: readonly Tool[]
  /** Policies seeded into the policy engine. */
  readonly policies?: readonly ToolPolicy[]
  /**
   * Event Store override. By default the runtime waits for the
   * `event-store` kernel service (for example the SQLite plugin).
   */
  readonly eventStore?: EventStore
}

interface PendingApproval {
  readonly request: ApprovalRequest
  resolve(approved: boolean): void
  reject(error: Error): void
}

interface ActiveRun {
  readonly taskId: string
  readonly scope: TaskScope
  readonly tools: ToolRegistry
  current: TaskSnapshot
  cancelled: boolean
  cancelReason: string | undefined
  pending: PendingApproval | undefined
}

/**
 * Runs tasks on top of the kernel: it creates task specs, executes agents
 * inside task scopes, records every step as append-only events, and drives
 * the approval lifecycle. Task state is always derivable from the event
 * stream, so snapshots survive runtime restarts.
 */
export class TaskRuntime {
  readonly #kernel: Kernel
  readonly #explicitStore: EventStore | undefined
  readonly #defaultAgent: Agent | undefined
  readonly #agents = new Map<string, Agent>()
  readonly #tools = new ToolRegistry()
  readonly #policies = new PolicyEngine()
  readonly #active = new Map<string, ActiveRun>()
  readonly #runningTasks = new Set<string>()
  readonly #pendingByRequest = new Map<string, ActiveRun>()
  readonly #locks = new Map<string, Promise<unknown>>()
  #storePromise: Promise<EventStore> | undefined

  constructor(kernel: Kernel, options: TaskRuntimeOptions = {}) {
    this.#kernel = kernel
    this.#explicitStore = options.eventStore
    this.#defaultAgent = options.defaultAgent
    for (const [id, agent] of Object.entries(options.agents ?? {})) {
      this.#agents.set(id, agent)
    }
    for (const tool of options.tools ?? []) this.#tools.register(tool)
    for (const policy of options.policies ?? []) this.#policies.register(policy)
  }

  get kernel(): Kernel {
    return this.#kernel
  }

  /** Global tool registry; each run gets an isolated clone of it. */
  get tools(): ToolRegistry {
    return this.#tools
  }

  get policies(): PolicyEngine {
    return this.#policies
  }

  registerAgent(agent: Agent): this {
    this.#agents.set(agent.id, agent)
    return this
  }

  /** Validates a creation request and records the `task.created` event. */
  async createTask(request: CreateTaskRequest): Promise<TaskSpec> {
    const parsed = CreateTaskRequestSchema.parse(request)
    const spec: TaskSpec = { ...parsed, id: randomUUID() }
    await this.#lifecycle(spec.id, 'task.created', { spec, state: 'pending' })
    return spec
  }

  /** Rebuilds the task snapshot by replaying its event stream. */
  async getSnapshot(taskId: string): Promise<TaskSnapshot> {
    const store = await this.#resolveStore()
    return reduceTaskSnapshot(taskId, store.readTask(taskId))
  }

  /** Streams recorded task events, optionally after a sequence. */
  async *readEvents(
    taskId: string,
    afterSequence = 0,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const store = await this.#resolveStore()
    yield* store.readTask(taskId, afterSequence)
  }

  /**
   * Starts a pending task and resolves with its final snapshot (`completed`,
   * `failed`, or `cancelled`) — task outcomes are data, not exceptions.
   */
  async run(taskId: string): Promise<TaskSnapshot> {
    // Reserved synchronously so a second run() cannot race past the first
    // one's initial snapshot replay.
    if (this.#active.has(taskId) || this.#runningTasks.has(taskId)) {
      throw new TaskAlreadyActiveError(taskId)
    }
    this.#runningTasks.add(taskId)
    try {
      return await this.#runTask(taskId)
    } finally {
      this.#runningTasks.delete(taskId)
    }
  }

  async #runTask(taskId: string): Promise<TaskSnapshot> {
    const snapshot = await this.getSnapshot(taskId)
    if (snapshot.lastSequence === 0) throw new UnknownTaskError(taskId)
    if (snapshot.state !== 'pending') {
      throw new InvalidTaskStateError(
        taskId,
        'run',
        snapshot.state,
        'only pending tasks can be started',
      )
    }
    const spec = snapshot.spec
    if (!spec) throw new UnknownTaskError(taskId)
    const agent = this.#resolveAgent(spec.agentId)
    const scope = this.#kernel.createTaskScope(taskId)
    const run: ActiveRun = {
      taskId,
      scope,
      tools: this.#tools.clone(),
      current: snapshot,
      cancelled: false,
      cancelReason: undefined,
      pending: undefined,
    }
    this.#active.set(taskId, run)
    const offPolicy = scope.events.use(
      toolExecuteEvent,
      toolPolicyMiddleware(this.#policies),
    )
    try {
      const context: AgentRunContext = {
        taskId,
        input: spec.input,
        metadata: spec.metadata,
        workspaceId: spec.workspaceId,
        tools: run.tools,
        get cancelled() {
          return run.cancelled
        },
        throwIfCancelled: () => {
          if (run.cancelled) {
            throw new TaskCancelledError(taskId, run.cancelReason)
          }
        },
        emit: (type, payload) => this.#emitAgentEvent(run, type, payload),
        emitMessage: (role, content) =>
          this.#emitAgentEvent(run, 'agent.message', { role, content }),
        callTool: (toolId, input) => this.#executeTool(run, toolId, input),
      }
      try {
        await this.#lifecycle(taskId, 'task.started', { state: 'running' })
        const result = await agent.run(context)
        if (run.cancelled) {
          throw new TaskCancelledError(taskId, run.cancelReason)
        }
        await this.#lifecycle(taskId, 'task.completed', {
          state: 'completed',
          result: result.output,
        })
      } catch (error) {
        await this.#settleFailure(run, error)
      }
      return run.current
    } finally {
      offPolicy()
      this.#rejectLeftoverApproval(run)
      this.#active.delete(taskId)
      this.#kernel.disposeTaskScope(taskId)
    }
  }

  /**
   * Cancels a pending, running, or suspended task. Running agents observe
   * cancellation cooperatively between steps; suspended approvals are
   * rejected immediately.
   */
  async cancel(taskId: string, reason?: string): Promise<TaskSnapshot> {
    await this.#withTaskLock(taskId, async () => {
      const current = await this.#liveSnapshot(taskId)
      if (current.lastSequence === 0) throw new UnknownTaskError(taskId)
      if (isTerminalTaskState(current.state)) {
        throw new InvalidTaskStateError(
          taskId,
          'cancel',
          current.state,
          'task already finished',
        )
      }
      const run = this.#active.get(taskId)
      if (run) {
        run.cancelled = true
        run.cancelReason = reason
      }
      await this.#appendValidated(taskId, 'task.cancelled', {
        state: 'cancelled',
        ...(reason !== undefined ? { reason } : {}),
      })
      if (run?.pending) this.#rejectLeftoverApproval(run)
    })
    return this.getSnapshot(taskId)
  }

  /** Decides a pending approval request and resumes the suspended task. */
  async resolveApproval(
    requestId: string,
    approved: boolean,
    options: { reason?: string } = {},
  ): Promise<ApprovalDecision> {
    const run = this.#pendingByRequest.get(requestId)
    const pending = run?.pending
    if (!run || !pending) throw new UnknownApprovalRequestError(requestId)
    const request = pending.request
    let effectiveApproved = approved
    let reason = options.reason
    if (
      request.expiresAt !== undefined &&
      Date.parse(request.expiresAt) <= Date.now()
    ) {
      effectiveApproved = false
      reason = 'approval request expired'
    }
    const decision: ApprovalDecision = {
      requestId,
      approved: effectiveApproved,
      decidedAt: new Date().toISOString(),
      ...(reason !== undefined ? { reason } : {}),
    }
    await this.#withTaskLock(run.taskId, async () => {
      if (run.pending !== pending) {
        throw new UnknownApprovalRequestError(requestId)
      }
      await this.#appendValidated(run.taskId, 'approval.decided', { decision })
      await this.#transitionLocked(run.taskId, 'task.resumed', {
        state: 'running',
        approvalId: requestId,
        approved: effectiveApproved,
      })
      run.pending = undefined
      this.#pendingByRequest.delete(requestId)
      pending.resolve(effectiveApproved)
    })
    return decision
  }

  #resolveAgent(agentId: string): Agent {
    const agent = this.#agents.get(agentId) ?? this.#defaultAgent
    if (!agent) throw new UnknownAgentError(agentId)
    return agent
  }

  async #resolveStore(): Promise<EventStore> {
    if (this.#explicitStore) return this.#explicitStore
    this.#storePromise ??= this.#kernel.waitForService(eventStoreService)
    return this.#storePromise
  }

  #withTaskLock<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(taskId) ?? Promise.resolve()
    const result = previous.then(action, action)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.#locks.set(taskId, tail)
    void tail.then(() => {
      if (this.#locks.get(taskId) === tail) this.#locks.delete(taskId)
    })
    return result
  }

  async #liveSnapshot(taskId: string): Promise<TaskSnapshot> {
    const run = this.#active.get(taskId)
    if (run) return run.current
    return this.getSnapshot(taskId)
  }

  async #lifecycle<K extends TaskLifecycleEventType>(
    taskId: string,
    type: K,
    payload: LifecyclePayloadMap[K],
  ): Promise<void> {
    await this.#withTaskLock(taskId, () =>
      this.#transitionLocked(taskId, type, payload),
    )
  }

  /**
   * Appends a lifecycle event; the caller must hold the task lock. Validates
   * the transition against the live snapshot before appending.
   */
  async #transitionLocked<K extends TaskLifecycleEventType>(
    taskId: string,
    type: K,
    payload: LifecyclePayloadMap[K],
  ): Promise<void> {
    const current = await this.#liveSnapshot(taskId)
    if (type === 'task.created') {
      if (current.lastSequence !== 0) {
        throw new TaskRuntimeError(`Task '${taskId}' already exists`)
      }
    } else {
      assertTaskTransition(current.state, payload.state)
    }
    await this.#appendValidated(taskId, type, payload)
  }

  async #emitAgentEvent(
    run: ActiveRun,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (RESERVED_EVENT_TYPES.includes(type)) {
      throw new TaskRuntimeError(
        `Event type '${type}' is reserved by the task runtime`,
      )
    }
    await this.#withTaskLock(run.taskId, () =>
      this.#appendValidated(run.taskId, type, payload),
    )
  }

  /** Appends, folds into the live run, and notifies observers. */
  async #appendValidated(
    taskId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const schema = EVENT_PAYLOAD_SCHEMAS[type as KnownEventName]
    const validated = schema
      ? (schema.parse(payload) as Record<string, unknown>)
      : { ...payload }
    const store = await this.#resolveStore()
    const event = await store.append({ taskId, type, payload: validated })
    const run = this.#active.get(taskId)
    if (run) run.current = applyTaskEvent(run.current, event)
    await this.#kernel.events.dispatch(taskEventRecordedEvent, { event })
  }

  #hooks(run: ActiveRun): ToolExecutionHooks {
    return {
      requestApproval: (input) => this.#requestApproval(run, input),
    }
  }

  async #requestApproval(
    run: ActiveRun,
    input: ApprovalRequestInput,
  ): Promise<boolean> {
    if (run.pending) {
      throw new TaskRuntimeError(
        `Task '${run.taskId}' already has a pending approval request`,
      )
    }
    const request: ApprovalRequest = {
      id: randomUUID(),
      taskId: run.taskId,
      toolCall: input.call,
      reason: input.reason,
      risk: input.risk,
      createdAt: new Date().toISOString(),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    }
    let decision: Promise<boolean> | undefined
    await this.#withTaskLock(run.taskId, async () => {
      await this.#appendValidated(run.taskId, 'approval.requested', {
        request,
      })
      await this.#transitionLocked(run.taskId, 'task.suspended', {
        state: 'waiting_approval',
        approvalId: request.id,
      })
      // Register the waiter while still holding the lock so a concurrent
      // cancel() cannot observe a suspended task with no one to reject.
      decision = new Promise<boolean>((resolve, reject) => {
        run.pending = { request, resolve, reject }
        this.#pendingByRequest.set(request.id, run)
      })
    })
    return decision!
  }

  async #executeTool(
    run: ActiveRun,
    toolId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (run.cancelled) {
      throw new TaskCancelledError(run.taskId, run.cancelReason)
    }
    const tool = run.tools.require(toolId)
    const call: ToolCall = {
      id: randomUUID(),
      taskId: run.taskId,
      toolId,
      arguments: input,
    }
    await this.#withTaskLock(run.taskId, () =>
      this.#appendValidated(run.taskId, 'tool.call', { call }),
    )
    const hooks = this.#hooks(run)
    const result = await run.scope.events.waterfall(
      toolExecuteEvent,
      { call, tool, hooks },
      async () => {
        try {
          const output = await tool.execute(input, {
            taskId: run.taskId,
            callId: call.id,
          })
          return { callId: call.id, output } satisfies ToolResult
        } catch (error) {
          return {
            callId: call.id,
            output: undefined,
            error: errorMessage(error),
          } satisfies ToolResult
        }
      },
    )
    await this.#withTaskLock(run.taskId, () =>
      this.#appendValidated(run.taskId, 'tool.result', { result }),
    )
    return result
  }

  async #settleFailure(run: ActiveRun, error: unknown): Promise<void> {
    if (isTerminalTaskState(run.current.state)) return
    if (run.cancelled || error instanceof TaskCancelledError) {
      await this.#lifecycle(run.taskId, 'task.cancelled', {
        state: 'cancelled',
        ...(run.cancelReason !== undefined ? { reason: run.cancelReason } : {}),
      })
      return
    }
    await this.#lifecycle(run.taskId, 'task.failed', {
      state: 'failed',
      error: errorMessage(error),
    })
  }

  #rejectLeftoverApproval(run: ActiveRun): void {
    const pending = run.pending
    if (!pending) return
    run.pending = undefined
    this.#pendingByRequest.delete(pending.request.id)
    pending.reject(new TaskCancelledError(run.taskId, run.cancelReason))
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  if (typeof error === 'string' && error.length > 0) return error
  return 'unknown error'
}
