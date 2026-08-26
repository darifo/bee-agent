import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJson } from '@bee-agent/kernel'
import {
  newChronicleEvent,
  type ChronicleSchemaRegistry,
  type ChronicleStore,
  type NewChronicleEvent,
} from '@bee-agent/knowledge'

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/)

export const ResourceRequirementsSchema = z.object({
  readPaths: z.array(z.string()).default([]),
  writePaths: z.array(z.string()).default([]),
  networkTargets: z.array(z.string()).default([]),
  commands: z.array(z.array(z.string())).default([]),
  secretRefs: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().optional(),
  maxOutputBytes: z.number().int().positive().optional(),
})
export type ResourceRequirements = z.infer<typeof ResourceRequirementsSchema>

export const ActionRequestSchema = z.object({
  id: z.uuid(),
  idempotencyKey: z.string().min(1),
  capability: z.string().min(1),
  subject: z.object({
    type: z.enum(['user', 'agent', 'system', 'tool']),
    id: z.string().min(1),
  }),
  input: z.unknown(),
  requirements: ResourceRequirementsSchema,
  expectedEffects: z.array(z.string().min(1)),
  verification: z.array(z.string().min(1)),
  scope: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    itemId: z.string().min(1).optional(),
  }),
  structureVersion: z.string().min(1).optional(),
})
export type ActionRequest = z.infer<typeof ActionRequestSchema>

export const ActionResultSchema = z.object({
  output: z.unknown(),
  content: z.string(),
  isError: z.boolean().optional(),
  worldDiff: z.unknown().optional(),
  verification: z.array(z.string()).default([]),
})
export type ActionResult = z.infer<typeof ActionResultSchema>

export type AuthorizationDecision =
  | { readonly decision: 'allow'; readonly reason: string }
  | { readonly decision: 'ask'; readonly reason: string }
  | { readonly decision: 'deny'; readonly reason: string }

export interface AuthorizationPolicy {
  authorize(request: ActionRequest): AuthorizationDecision
}

export type CapabilityRule = AuthorizationDecision & {
  readonly capability: string
}

/** Exact capability rules with deny-by-default behavior. */
export class StaticAuthorizationPolicy implements AuthorizationPolicy {
  readonly #rules: ReadonlyMap<string, AuthorizationDecision>

  constructor(rules: readonly CapabilityRule[]) {
    this.#rules = new Map(
      rules.map(({ capability, ...decision }) => [capability, decision]),
    )
  }

  authorize(request: ActionRequest): AuthorizationDecision {
    return (
      this.#rules.get(request.capability) ?? {
        decision: 'deny',
        reason: `Capability '${request.capability}' is not declared`,
      }
    )
  }
}

export interface SandboxCapabilityReport {
  readonly provider: string
  readonly filesystemIsolation: boolean
  readonly networkIsolation: boolean
  readonly processIsolation: boolean
}

export interface WorldSnapshot {
  readonly ref: string
  readonly capturedAt: string
  readonly state?: unknown
}

export interface SandboxProvider {
  execute(
    request: ActionRequest,
    options: {
      readonly signal?: AbortSignal | undefined
      readonly secrets: ReadonlyMap<string, string>
    },
  ): Promise<ActionResult>
  snapshot(scope: ActionRequest['scope']): Promise<WorldSnapshot>
  diff(before: WorldSnapshot, after: WorldSnapshot): Promise<unknown>
  capabilities(): Promise<SandboxCapabilityReport>
}

export interface SecretBroker {
  materialize(
    refs: readonly string[],
    request: ActionRequest,
  ): Promise<ReadonlyMap<string, string>>
  redact(value: string): string
}

export type ExecutionOutcome =
  | {
      readonly kind: 'result'
      readonly result: ActionResult
      readonly replayed: boolean
    }
  | {
      readonly kind: 'approval-required'
      readonly approvalId: string
      readonly title: string
      readonly detail: string
    }
  | { readonly kind: 'denied'; readonly reason: string }
  | { readonly kind: 'reconciliation-required'; readonly reason: string }

export interface ExecutionOptions {
  readonly approval?: 'approved' | 'rejected' | undefined
  readonly signal?: AbortSignal | undefined
}

const RequestedPayloadSchema = z.object({
  request: ActionRequestSchema,
  requestDigest: DigestSchema,
})
const DecisionPayloadSchema = z.object({
  requestId: z.uuid(),
  decision: z.enum(['allow', 'ask', 'deny']),
  reason: z.string().min(1),
})
const ApprovalPayloadSchema = z.object({
  requestId: z.uuid(),
  approvalId: z.string().min(1),
  title: z.string().min(1),
  detail: z.string().min(1),
})
const StartedPayloadSchema = z.object({ requestId: z.uuid() })
const CompletedPayloadSchema = z.object({
  requestId: z.uuid(),
  result: ActionResultSchema,
})
const FailedPayloadSchema = z.object({
  requestId: z.uuid(),
  message: z.string().min(1),
})

export const EXECUTION_EVENT_TYPES = [
  'execution.requested',
  'execution.authorized',
  'execution.approval_required',
  'execution.denied',
  'execution.started',
  'execution.completed',
  'execution.failed',
] as const

export function registerExecutionChronicleEvents(
  registry: ChronicleSchemaRegistry,
): void {
  registry.register('execution.requested', { payload: RequestedPayloadSchema })
  registry.register('execution.authorized', { payload: DecisionPayloadSchema })
  registry.register('execution.approval_required', {
    payload: ApprovalPayloadSchema,
  })
  registry.register('execution.denied', { payload: DecisionPayloadSchema })
  registry.register('execution.started', { payload: StartedPayloadSchema })
  registry.register('execution.completed', { payload: CompletedPayloadSchema })
  registry.register('execution.failed', { payload: FailedPayloadSchema })
}

export function executionStreamId(idempotencyKey: string): string {
  return `execution:${createHash('sha256').update(idempotencyKey).digest('hex')}`
}

function requestDigest(request: ActionRequest): string {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(request))
    .digest('hex')}`
}

function event(
  eventType: (typeof EXECUTION_EVENT_TYPES)[number],
  request: ActionRequest,
  payload: unknown,
): NewChronicleEvent {
  return newChronicleEvent({
    eventType,
    actor: request.subject,
    threadId: request.scope.threadId,
    turnId: request.scope.turnId,
    structureVersion: request.structureVersion,
    payload,
  })
}

function approvalDetail(request: ActionRequest): string {
  return canonicalJson({
    capability: request.capability,
    input: request.input,
    requirements: request.requirements,
    expectedEffects: request.expectedEffects,
    verification: request.verification,
  })
}

export class IdempotencyKeyCollisionError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`Idempotency key '${idempotencyKey}' was reused for another action`)
    this.name = 'IdempotencyKeyCollisionError'
  }
}

/** Durable authorize → sandbox → verify → emit execution boundary. */
export class ExecutionWorld {
  readonly #store: ChronicleStore
  readonly #policy: AuthorizationPolicy
  readonly #sandbox: SandboxProvider
  readonly #secrets: SecretBroker | undefined
  readonly #inflight = new Map<string, Promise<ExecutionOutcome>>()

  constructor(options: {
    readonly store: ChronicleStore
    readonly policy: AuthorizationPolicy
    readonly sandbox: SandboxProvider
    readonly secrets?: SecretBroker | undefined
  }) {
    this.#store = options.store
    this.#policy = options.policy
    this.#sandbox = options.sandbox
    this.#secrets = options.secrets
  }

  async execute(
    candidate: ActionRequest,
    options: ExecutionOptions = {},
  ): Promise<ExecutionOutcome> {
    const request = ActionRequestSchema.parse(candidate)
    const active = this.#inflight.get(request.idempotencyKey)
    if (active !== undefined) {
      await active
      return this.execute(request, options)
    }
    const task = this.#execute(request, options)
    this.#inflight.set(request.idempotencyKey, task)
    try {
      return await task
    } finally {
      if (this.#inflight.get(request.idempotencyKey) === task) {
        this.#inflight.delete(request.idempotencyKey)
      }
    }
  }

  async #execute(
    request: ActionRequest,
    options: ExecutionOptions,
  ): Promise<ExecutionOutcome> {
    const streamId = executionStreamId(request.idempotencyKey)
    const existing = await this.#read(streamId)
    const requested = existing.find(
      (item) => item.eventType === 'execution.requested',
    )
    const digest = requestDigest(request)
    if (requested !== undefined) {
      const payload = RequestedPayloadSchema.parse(requested.payload)
      if (payload.requestDigest !== digest) {
        throw new IdempotencyKeyCollisionError(request.idempotencyKey)
      }
      const completed = existing.find(
        (item) => item.eventType === 'execution.completed',
      )
      if (completed !== undefined) {
        return {
          kind: 'result',
          result: CompletedPayloadSchema.parse(completed.payload).result,
          replayed: true,
        }
      }
      if (existing.some((item) => item.eventType === 'execution.started')) {
        return {
          kind: 'reconciliation-required',
          reason:
            'The action started without a durable result; automatic replay is unsafe',
        }
      }
      const denied = existing.find(
        (item) => item.eventType === 'execution.denied',
      )
      if (denied !== undefined) {
        return {
          kind: 'denied',
          reason: DecisionPayloadSchema.parse(denied.payload).reason,
        }
      }
    } else {
      await this.#append(streamId, [
        event(
          'execution.requested',
          request,
          RequestedPayloadSchema.parse({ request, requestDigest: digest }),
        ),
      ])
    }

    const decision = this.#policy.authorize(request)
    if (decision.decision === 'deny' || options.approval === 'rejected') {
      const reason =
        options.approval === 'rejected'
          ? 'The user rejected this action'
          : decision.reason
      await this.#append(streamId, [
        event('execution.denied', request, {
          requestId: request.id,
          decision: 'deny',
          reason,
        }),
      ])
      return { kind: 'denied', reason }
    }
    if (decision.decision === 'ask' && options.approval !== 'approved') {
      const approvalId = request.id
      const title = `Allow ${request.capability}?`
      const detail = approvalDetail(request)
      if (
        !existing.some(
          (item) => item.eventType === 'execution.approval_required',
        )
      ) {
        await this.#append(streamId, [
          event('execution.approval_required', request, {
            requestId: request.id,
            approvalId,
            title,
            detail,
          }),
        ])
      }
      return { kind: 'approval-required', approvalId, title, detail }
    }

    if (
      request.requirements.secretRefs.length > 0 &&
      this.#secrets === undefined
    ) {
      const reason = 'The action requires secrets but no SecretBroker is active'
      await this.#append(streamId, [
        event('execution.denied', request, {
          requestId: request.id,
          decision: 'deny',
          reason,
        }),
      ])
      return { kind: 'denied', reason }
    }

    const capabilities = await this.#sandbox.capabilities()
    const unsupported = [
      request.requirements.readPaths.length > 0 &&
      !capabilities.filesystemIsolation
        ? 'readPaths'
        : undefined,
      request.requirements.writePaths.length > 0 &&
      !capabilities.filesystemIsolation
        ? 'writePaths'
        : undefined,
      request.requirements.networkTargets.length > 0 &&
      !capabilities.networkIsolation
        ? 'networkTargets'
        : undefined,
      request.requirements.commands.length > 0 && !capabilities.processIsolation
        ? 'commands'
        : undefined,
    ].filter((value): value is string => value !== undefined)
    if (unsupported.length > 0) {
      const reason = `Sandbox '${capabilities.provider}' cannot enforce: ${unsupported.join(', ')}`
      await this.#append(streamId, [
        event('execution.denied', request, {
          requestId: request.id,
          decision: 'deny',
          reason,
        }),
      ])
      return { kind: 'denied', reason }
    }

    await this.#append(streamId, [
      event('execution.authorized', request, {
        requestId: request.id,
        decision: 'allow',
        reason:
          decision.decision === 'ask'
            ? 'User approved the action'
            : decision.reason,
      }),
      event('execution.started', request, { requestId: request.id }),
    ])
    try {
      const secrets =
        (await this.#secrets?.materialize(
          request.requirements.secretRefs,
          request,
        )) ?? new Map<string, string>()
      const before = await this.#sandbox.snapshot(request.scope)
      const result = ActionResultSchema.parse(
        await this.#sandbox.execute(request, {
          signal: options.signal,
          secrets,
        }),
      )
      const after = await this.#sandbox.snapshot(request.scope)
      const worldDiff = await this.#sandbox.diff(before, after)
      const safeResult =
        this.#secrets === undefined
          ? { ...result, worldDiff }
          : {
              ...result,
              output: redactUnknown(result.output, this.#secrets),
              content: this.#secrets.redact(result.content),
              worldDiff: redactUnknown(worldDiff, this.#secrets),
            }
      await this.#append(streamId, [
        event('execution.completed', request, {
          requestId: request.id,
          result: safeResult,
        }),
      ])
      return { kind: 'result', result: safeResult, replayed: false }
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error)
      const message = this.#secrets?.redact(rawMessage) ?? rawMessage
      await this.#append(streamId, [
        event('execution.failed', request, {
          requestId: request.id,
          message: message === '' ? 'Unknown execution failure' : message,
        }),
      ])
      return {
        kind: 'result',
        replayed: false,
        result: {
          output: { error: message },
          content: message,
          isError: true,
          verification: [],
        },
      }
    }
  }

  snapshot(scope: ActionRequest['scope']): Promise<WorldSnapshot> {
    return this.#sandbox.snapshot(scope)
  }

  diff(before: WorldSnapshot, after: WorldSnapshot): Promise<unknown> {
    return this.#sandbox.diff(before, after)
  }

  capabilities(): Promise<SandboxCapabilityReport> {
    return this.#sandbox.capabilities()
  }

  async #read(streamId: string) {
    const events = []
    for await (const item of this.#store.readStream(streamId)) events.push(item)
    return events
  }

  async #append(
    streamId: string,
    events: readonly NewChronicleEvent[],
  ): Promise<void> {
    if (events.length === 0) return
    const expectedSequence = (await this.#store.getLatestSequence(streamId)) + 1
    await this.#store.append(streamId, events, { expectedSequence })
  }
}

function redactUnknown(value: unknown, broker: SecretBroker): unknown {
  if (typeof value === 'string') return broker.redact(value)
  if (Array.isArray(value))
    return value.map((item) => redactUnknown(item, broker))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactUnknown(item, broker),
      ]),
    )
  }
  return value
}
