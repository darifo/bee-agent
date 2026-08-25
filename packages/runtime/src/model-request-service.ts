import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  buildContextManifest,
  contextManifestEvent,
  rebuildContextInput,
  registerContextManifestChronicleEvents,
  type ContextManifest,
  type ContextRenderer,
  type ContextSectionDraft,
} from '@bee-agent/context'
import { canonicalJson } from '@bee-agent/kernel'
import {
  newChronicleEvent,
  type ChronicleSchemaRegistry,
  type ChronicleStore,
  type NewChronicleEvent,
} from '@bee-agent/knowledge'
import type {
  ContextBundle,
  LlmCall,
  LlmCallOptions,
  LlmMessage,
  LlmRuntime,
  LlmToolSpec,
} from './llm-runtime.ts'

export const MODEL_REQUEST_SERVICE = 'modelRequest'
export const MODEL_REQUEST_EVENT_TYPES = [
  'model.requested',
  'model.completed',
  'model.failed',
] as const

const RequestedPayloadSchema = z.object({
  requestId: z.uuid(),
  manifestId: z.uuid(),
  stepIndex: z.number().int().nonnegative(),
  attempt: z.number().int().nonnegative(),
  model: z.string().min(1),
  inputDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  sources: z.record(z.string(), z.string()),
})

const LlmResultSchema = z.object({
  stopReason: z.enum([
    'end_turn',
    'tool_calls',
    'decision',
    'max_tokens',
    'cancelled',
  ]),
  usage: z.object({
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
  }),
  provider: z.object({
    id: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  latencyMs: z.number().nonnegative(),
})

const CompletedPayloadSchema = z.object({
  requestId: z.uuid(),
  result: LlmResultSchema,
})

const FailedPayloadSchema = z.object({
  requestId: z.uuid(),
  message: z.string().min(1),
  errorName: z.string().min(1),
})

export function registerModelRequestChronicleEvents(
  registry: ChronicleSchemaRegistry,
): void {
  if (!registry.has('context.manifest')) {
    registerContextManifestChronicleEvents(registry)
  }
  registry.register('model.requested', { payload: RequestedPayloadSchema })
  registry.register('model.completed', { payload: CompletedPayloadSchema })
  registry.register('model.failed', { payload: FailedPayloadSchema })
}

export function modelRequestStreamId(requestId: string): string {
  return `model-request:${requestId}`
}

export interface ModelRequestServiceOptions {
  readonly store: ChronicleStore
  readonly llm: LlmRuntime
  readonly promptVersion: string
  readonly structureVersion: string
  readonly tokenBudget?: number | undefined
}

export interface ModelRequestInput {
  readonly threadId: string
  readonly turnId: string
  readonly stepIndex: number
  readonly attempt: number
  readonly bundle: ContextBundle
  readonly structureVersion?: string | undefined
  readonly options?: LlmCallOptions | undefined
}

export interface TrackedLlmCall extends LlmCall {
  readonly requestId: string
  readonly manifest: ContextManifest
}

export interface RebuiltModelRequest {
  readonly requestId: string
  readonly manifest: ContextManifest
  readonly bundle: ContextBundle
}

const MESSAGE_RENDERER = 'llm-message-json@1'
const TOOL_RENDERER = 'llm-tool-json@1'
const DECISION_RENDERER = 'llm-decision-json@1'

const identityRenderer = (version: string): ContextRenderer => ({
  version,
  render(sourceIds, sources) {
    if (sourceIds.length !== 1) {
      throw new Error(`Renderer '${version}' expects exactly one source`)
    }
    const value = sources.get(sourceIds[0] as string)
    if (value === undefined)
      throw new Error(`Source '${sourceIds[0]}' not found`)
    return value
  },
})

const RENDERERS = new Map<string, ContextRenderer>([
  [MESSAGE_RENDERER, identityRenderer(MESSAGE_RENDERER)],
  [TOOL_RENDERER, identityRenderer(TOOL_RENDERER)],
  [DECISION_RENDERER, identityRenderer(DECISION_RENDERER)],
])

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function describeBundle(bundle: ContextBundle): {
  readonly sources: Map<string, string>
  readonly sections: ContextSectionDraft[]
} {
  const sources = new Map<string, string>()
  const sections: ContextSectionDraft[] = []
  let priority = 0
  bundle.messages.forEach((message, index) => {
    const sourceId = `message:${index}`
    const content = canonicalJson(message)
    sources.set(sourceId, content)
    sections.push({
      kind: message.role === 'system' ? 'instruction' : 'trajectory',
      sourceIds: [sourceId],
      rendererVersion: MESSAGE_RENDERER,
      priority: priority++,
      content,
    })
  })
  bundle.tools.forEach((tool, index) => {
    const sourceId = `tool:${index}`
    const content = canonicalJson(tool)
    sources.set(sourceId, content)
    sections.push({
      kind: 'tool',
      sourceIds: [sourceId],
      rendererVersion: TOOL_RENDERER,
      priority: priority++,
      content,
    })
  })
  if (bundle.decisionSchema !== undefined) {
    const sourceId = 'decision:0'
    const content = canonicalJson(bundle.decisionSchema)
    sources.set(sourceId, content)
    sections.push({
      kind: 'goal',
      sourceIds: [sourceId],
      rendererVersion: DECISION_RENDERER,
      priority,
      content,
    })
  }
  return { sources, sections }
}

function modelEvent(
  eventType: (typeof MODEL_REQUEST_EVENT_TYPES)[number],
  payload: unknown,
  input: Pick<ModelRequestInput, 'threadId' | 'turnId'>,
  structureVersion: string,
  manifestId: string,
): NewChronicleEvent {
  return newChronicleEvent({
    eventType,
    actor: { type: 'system', id: 'model-request' },
    threadId: input.threadId,
    turnId: input.turnId,
    structureVersion,
    contextManifestId: manifestId,
    payload,
  })
}

/** Durable boundary around the stateless provider call. */
export class ModelRequestService {
  readonly #options: ModelRequestServiceOptions

  constructor(options: ModelRequestServiceOptions) {
    this.#options = options
  }

  async generate(input: ModelRequestInput): Promise<TrackedLlmCall> {
    const requestId = crypto.randomUUID()
    const manifestId = crypto.randomUUID()
    const structureVersion =
      input.structureVersion ?? this.#options.structureVersion
    const described = describeBundle(input.bundle)
    const manifest = buildContextManifest({
      id: manifestId,
      promptVersion: this.#options.promptVersion,
      structureVersion,
      tokenBudget:
        this.#options.tokenBudget ??
        this.#options.llm.capabilities().maxContextTokens,
      sections: described.sections,
    })
    const requested = RequestedPayloadSchema.parse({
      requestId,
      manifestId,
      stepIndex: input.stepIndex,
      attempt: input.attempt,
      model: this.#options.llm.model,
      inputDigest: digest(input.bundle),
      sources: Object.fromEntries(described.sources),
    })
    const streamId = modelRequestStreamId(requestId)
    await this.#options.store.append(
      streamId,
      [
        contextManifestEvent(manifest, {
          threadId: input.threadId,
          turnId: input.turnId,
          structureVersion,
        }),
        modelEvent(
          'model.requested',
          requested,
          input,
          structureVersion,
          manifestId,
        ),
      ],
      { expectedSequence: 1 },
    )

    let call: LlmCall
    try {
      call = this.#options.llm.generate(input.bundle, input.options)
    } catch (error) {
      await this.#appendFailure(
        streamId,
        input,
        structureVersion,
        manifestId,
        requestId,
        error,
      )
      throw error
    }

    const result = call.result.then(
      async (value) => {
        await this.#appendTerminal(
          streamId,
          modelEvent(
            'model.completed',
            CompletedPayloadSchema.parse({ requestId, result: value }),
            input,
            structureVersion,
            manifestId,
          ),
        )
        return value
      },
      async (error: unknown) => {
        await this.#appendFailure(
          streamId,
          input,
          structureVersion,
          manifestId,
          requestId,
          error,
        )
        throw error
      },
    )
    return { requestId, manifest, events: call.events, result }
  }

  async #appendFailure(
    streamId: string,
    input: ModelRequestInput,
    structureVersion: string,
    manifestId: string,
    requestId: string,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    await this.#appendTerminal(
      streamId,
      modelEvent(
        'model.failed',
        FailedPayloadSchema.parse({
          requestId,
          message: message === '' ? 'Unknown model failure' : message,
          errorName: error instanceof Error ? error.name : 'Error',
        }),
        input,
        structureVersion,
        manifestId,
      ),
    )
  }

  async #appendTerminal(
    streamId: string,
    event: NewChronicleEvent,
  ): Promise<void> {
    const expectedSequence =
      (await this.#options.store.getLatestSequence(streamId)) + 1
    await this.#options.store.append(streamId, [event], { expectedSequence })
  }
}

/** Rebuilds and digest-checks the exact bundle sent for a historical call. */
export async function rebuildModelRequest(
  store: ChronicleStore,
  requestId: string,
): Promise<RebuiltModelRequest> {
  let manifest: ContextManifest | undefined
  let requested: z.infer<typeof RequestedPayloadSchema> | undefined
  for await (const event of store.readStream(modelRequestStreamId(requestId))) {
    if (event.eventType === 'context.manifest') {
      manifest = (event.payload as { manifest: ContextManifest }).manifest
    } else if (event.eventType === 'model.requested') {
      requested = RequestedPayloadSchema.parse(event.payload)
    }
  }
  if (manifest === undefined || requested === undefined) {
    throw new Error(`Model request '${requestId}' is incomplete`)
  }
  const rebuilt = rebuildContextInput(
    manifest,
    new Map(Object.entries(requested.sources)),
    RENDERERS,
  )
  const messages: LlmMessage[] = []
  const tools: LlmToolSpec[] = []
  let decisionSchema: Record<string, unknown> | undefined
  for (const section of rebuilt) {
    if (section.section.rendererVersion === MESSAGE_RENDERER) {
      messages.push(JSON.parse(section.text) as LlmMessage)
    } else if (section.section.rendererVersion === TOOL_RENDERER) {
      tools.push(JSON.parse(section.text) as LlmToolSpec)
    } else if (section.section.rendererVersion === DECISION_RENDERER) {
      decisionSchema = JSON.parse(section.text) as Record<string, unknown>
    }
  }
  const bundle: ContextBundle = {
    messages,
    tools,
    ...(decisionSchema === undefined ? {} : { decisionSchema }),
  }
  const actual = digest(bundle)
  if (actual !== requested.inputDigest) {
    throw new Error(
      `Model request '${requestId}' rebuilt to ${actual}, expected ${requested.inputDigest}`,
    )
  }
  return { requestId, manifest, bundle }
}
