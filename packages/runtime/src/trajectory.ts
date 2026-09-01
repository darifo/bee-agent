import type { ChronicleEvent, ChronicleStore } from '@bee-agent/knowledge'
import {
  MEMORY_STREAM_ID,
  STRUCTURE_STREAM_ID,
  WORLD_STREAM_ID,
} from '@bee-agent/knowledge'
import { readThreadEvents } from '@bee-agent/thread'
import { executionStreamId } from '@bee-agent/execution'
import { rebuildModelRequest } from './model-request-service.ts'
import type { RebuiltModelRequest } from './model-request-service.ts'
import { SCHEDULER_STREAM_ID } from './scheduler-events.ts'

/**
 * Trajectory views (architecture §7.4, v1 refactor plan §5.5 WF4-E): a
 * causal projection over the facts a Turn already produced — thread items
 * for what happened, model-request streams for exactly what the model saw
 * (digest-verified), and execution streams for each tool's capability,
 * authorization decision, and outcome. Nothing is copied: the view indexes
 * Chronicle positions, so "which structure ran this call, which policy
 * decided this tool, what did the model actually see" are one query each.
 */

export interface TrajectoryGeneration {
  readonly kind: 'generation'
  readonly stepIndex: number
  readonly attempt: number
  readonly requestId: string
  readonly model: string
  readonly inputDigest: string
  /** The structure the call ran under (envelope structureVersion). */
  readonly structureVersion: string | undefined
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
}

export interface TrajectoryTool {
  readonly kind: 'tool'
  readonly callId: string
  readonly toolId: string
  readonly itemId: string
  readonly executionStreamId: string
  readonly capability: string | undefined
  /** The final authorization decision recorded for the action. */
  readonly decision: 'allow' | 'ask' | 'deny' | undefined
  readonly decisionReason: string | undefined
  readonly outcome: 'completed' | 'failed' | 'denied' | 'started' | 'unknown'
  readonly isError: boolean | undefined
  /** The structure the action ran under. */
  readonly structureVersion: string | undefined
}

export interface TrajectoryCheckpoint {
  readonly sequence: number
  readonly stepIndex: number
  readonly stateDigest: string
}

export interface TurnTrajectory {
  readonly threadId: string
  readonly turnId: string
  readonly status: string | undefined
  readonly trigger: string | undefined
  readonly input: string | undefined
  readonly generations: readonly TrajectoryGeneration[]
  readonly tools: readonly TrajectoryTool[]
  readonly checkpoints: readonly TrajectoryCheckpoint[]
}

/**
 * Scans model-request streams for requests whose envelope scope matches the
 * turn. Personal-host scale keeps the scan bounded; a larger deployment
 * would add a turn → requestIds index event.
 */
async function generationsForTurn(
  store: ChronicleStore,
  threadId: string,
  turnId: string,
): Promise<TrajectoryGeneration[]> {
  const found: TrajectoryGeneration[] = []
  for (const streamId of await store.listStreams()) {
    if (!streamId.startsWith('model-request:')) continue
    let requested:
      | {
          stepIndex: number
          attempt: number
          requestId: string
          model: string
          inputDigest: string
          structureVersion: string | undefined
        }
      | undefined
    let stopReason: string | undefined
    let usage: TrajectoryGeneration['usage']
    let latencyMs: number | undefined
    let error: string | undefined
    let matches = false
    for await (const event of store.readStream(streamId)) {
      if (event.eventType === 'model.requested') {
        matches = event.threadId === threadId && event.turnId === turnId
        if (!matches) continue
        const payload = event.payload as {
          stepIndex: number
          attempt: number
          requestId: string
          model: string
          inputDigest: string
        }
        requested = {
          stepIndex: payload.stepIndex,
          attempt: payload.attempt,
          requestId: payload.requestId,
          model: payload.model,
          inputDigest: payload.inputDigest,
          structureVersion: event.structureVersion,
        }
      } else if (matches && event.eventType === 'model.completed') {
        const payload = event.payload as {
          result: {
            stopReason: string
            usage: TrajectoryGeneration['usage']
            latencyMs: number
          }
        }
        stopReason = payload.result.stopReason
        usage = payload.result.usage
        latencyMs = payload.result.latencyMs
      } else if (matches && event.eventType === 'model.failed') {
        error = (event.payload as { message: string }).message
      }
    }
    if (requested !== undefined) {
      found.push({
        kind: 'generation',
        ...requested,
        stopReason,
        usage,
        latencyMs,
        error,
      })
    }
  }
  return found.sort(
    (a, b) => a.stepIndex - b.stepIndex || a.attempt - b.attempt,
  )
}

async function toolTrajectory(
  store: ChronicleStore,
  ids: { callId: string; toolId: string; itemId: string },
  streamId: string,
): Promise<TrajectoryTool> {
  let capability: string | undefined
  let decision: TrajectoryTool['decision']
  let decisionReason: string | undefined
  let outcome: TrajectoryTool['outcome'] = 'unknown'
  let isError: boolean | undefined
  let structureVersion: string | undefined
  for await (const event of store.readStream(streamId)) {
    switch (event.eventType) {
      case 'execution.requested': {
        const payload = event.payload as {
          request: { capability?: string }
        }
        capability = payload.request.capability
        structureVersion = event.structureVersion
        outcome = 'started'
        continue
      }
      case 'execution.permission_snapshot': {
        const payload = event.payload as {
          snapshot: { capability: string }
        }
        capability = payload.snapshot.capability
        continue
      }
      case 'execution.authorized':
      case 'execution.denied': {
        const payload = event.payload as {
          decision: TrajectoryTool['decision']
          reason: string
        }
        decision = payload.decision
        decisionReason = payload.reason
        continue
      }
      case 'execution.completed': {
        const payload = event.payload as { result: { isError?: boolean } }
        outcome = 'completed'
        isError = payload.result.isError
        continue
      }
      case 'execution.failed': {
        outcome = 'failed'
        continue
      }
      default:
        continue
    }
  }
  if (outcome === 'started' && decision === 'deny') outcome = 'denied'
  return {
    kind: 'tool',
    callId: ids.callId,
    toolId: ids.toolId,
    itemId: ids.itemId,
    executionStreamId: streamId,
    capability,
    decision,
    decisionReason,
    outcome,
    isError,
    structureVersion,
  }
}

/**
 * Assembles the trajectory for one Turn from its thread items, model
 * requests, and execution streams. Every entry cites durable positions —
 * the view is a projection, never a copy.
 */
export async function buildTurnTrajectory(
  store: ChronicleStore,
  threadId: string,
  turnId: string,
): Promise<TurnTrajectory> {
  const page = await readThreadEvents(store, threadId)
  const checkpoints: TrajectoryCheckpoint[] = []
  const toolIds: { callId: string; toolId: string; itemId: string }[] = []
  let status: string | undefined
  let trigger: string | undefined
  let input: string | undefined
  let seenTurn = false
  for (const event of page.events) {
    if ('turnId' in event && event.turnId !== turnId) continue
    if (event.event === 'turn.started') {
      seenTurn = true
      trigger = event.turn.trigger
      input = event.turn.input
    } else if (
      event.event === 'turn.completed' ||
      event.event === 'turn.failed' ||
      event.event === 'turn.cancelled'
    ) {
      status = event.turn.status
    } else if (event.event === 'agent.checkpoint') {
      checkpoints.push({
        sequence: event.sequence,
        stepIndex: event.stepIndex,
        stateDigest: event.stateDigest,
      })
    } else if (
      event.event === 'item.completed' &&
      event.item.type === 'tool_call'
    ) {
      toolIds.push({
        callId: event.item.payload.callId,
        toolId: event.item.payload.toolId,
        itemId: event.item.id,
      })
    }
  }
  if (!seenTurn) {
    throw new Error(`Turn '${turnId}' not found in thread '${threadId}'`)
  }

  const tools: TrajectoryTool[] = []
  for (const ids of toolIds) {
    const streamId = executionStreamId(`tool:${turnId}:${ids.callId}`)
    tools.push(await toolTrajectory(store, ids, streamId))
  }

  return {
    threadId,
    turnId,
    status,
    trigger,
    input,
    generations: await generationsForTurn(store, threadId, turnId),
    tools,
    checkpoints,
  }
}

/**
 * Replays the exact model-visible context of one request: manifest, sources,
 * and the rebuilt bundle, digest-verified against what was sent.
 */
export function replayGeneration(
  store: ChronicleStore,
  requestId: string,
): Promise<RebuiltModelRequest> {
  return rebuildModelRequest(store, requestId)
}

// ---------------------------------------------------------------------------
// Global trajectory: one observable timeline over every Chronicle stream
// ---------------------------------------------------------------------------

/**
 * The learning stream id, owned by `@bee-agent/learning`. Runtime keeps the
 * projection dependency-free: the id is a stable wire contract, not a type.
 */
const LEARNING_STREAM_ID = 'learning'

/** Fast loop: user-facing turns (threads, model requests, executions). */
export type TrajectoryLoop = 'fast' | 'slow'

/**
 * User-facing buckets the console filters by. `input` is what the user said,
 * `llm` is what the model saw/said, `tool` is the execution boundary,
 * `memory`/`reasoning`/`proposal` are the slow loop's phases, `system` is
 * everything structural (scheduler, structure, world, thread lifecycle).
 */
export type TrajectoryCategory =
  'input' | 'llm' | 'tool' | 'memory' | 'reasoning' | 'proposal' | 'system'

export interface TrajectoryEntry {
  readonly eventId: string
  readonly streamId: string
  readonly sequence: number
  readonly eventTime: string
  readonly eventType: string
  readonly loop: TrajectoryLoop
  readonly category: TrajectoryCategory
  /** Data-derived one-line summary (content, model, tool, verdict, counts). */
  readonly summary: string
  readonly threadId: string | undefined
  readonly turnId: string | undefined
  /** The event payload, size-trimmed for inspection. */
  readonly detail: Record<string, unknown> | undefined
}

export interface GlobalTrajectoryQuery {
  readonly loop?: TrajectoryLoop | undefined
  readonly category?: TrajectoryCategory | undefined
  readonly streamId?: string | undefined
  /** Newest-first page size; default 100, capped at 500. */
  readonly limit?: number | undefined
}

export interface GlobalTrajectory {
  readonly entries: readonly TrajectoryEntry[]
  /** Event counts within the scanned window, before category filtering. */
  readonly counts: {
    readonly fast: number
    readonly slow: number
    readonly byCategory: Readonly<Record<TrajectoryCategory, number>>
  }
  readonly scannedStreams: number
}

function loopOfStream(streamId: string): TrajectoryLoop {
  if (
    streamId.startsWith('thread:') ||
    streamId.startsWith('model-request:') ||
    streamId.startsWith('execution:')
  ) {
    return 'fast'
  }
  return 'slow'
}

/** Deep-trims a payload so one entry can never flood the timeline response. */
function trimDetail(value: unknown, budget: { left: number }): unknown {
  if (typeof value === 'string') {
    if (value.length <= 512 || budget.left <= 0) return value.slice(0, 512)
    budget.left -= value.length
    return `${value.slice(0, 512)}…[truncated ${value.length - 512} chars]`
  }
  if (Array.isArray(value)) {
    const shown = value.slice(0, 50).map((item) => trimDetail(item, budget))
    if (value.length > 50) shown.push(`[+${value.length - 50} more]`)
    return shown
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = trimDetail(item, budget)
    }
    return out
  }
  return value
}

function clip(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

function payloadOf(event: ChronicleEvent): Record<string, unknown> {
  return event.payload !== null && typeof event.payload === 'object'
    ? (event.payload as Record<string, unknown>)
    : {}
}

interface EntryDraft {
  readonly event: ChronicleEvent
  readonly loop: TrajectoryLoop
  readonly category: TrajectoryCategory
  readonly summary: string
}

/**
 * Maps one stored event onto its timeline bucket. Streaming noise
 * (`item.delta`, `item.started`, execution snapshots) is dropped: those facts
 * stay in their streams — the timeline shows what happened, not every byte.
 */
function classify(
  streamId: string,
  event: ChronicleEvent,
): EntryDraft | undefined {
  const payload = payloadOf(event)
  const loop = loopOfStream(streamId)

  if (streamId.startsWith('thread:')) {
    switch (event.eventType) {
      case 'turn.started': {
        const turn = payload.turn as { input?: unknown } | undefined
        return {
          event,
          loop,
          category: 'input',
          summary: clip(String(turn?.input ?? '')),
        }
      }
      case 'item.completed': {
        const item = payload.item as
          | {
              type?: string
              payload?: {
                role?: string
                content?: string
                toolCalls?: readonly unknown[]
                toolId?: string
                title?: string
              }
            }
          | undefined
        if (item?.type === 'message') {
          if (item.payload?.role !== 'assistant') return undefined
          const content = clip(String(item.payload.content ?? ''))
          const summary =
            content !== ''
              ? content
              : `发起 ${item.payload.toolCalls?.length ?? 0} 个工具调用`
          return {
            event,
            loop,
            category: 'llm',
            summary,
          }
        }
        if (item?.type === 'tool_call') {
          return {
            event,
            loop,
            category: 'tool',
            summary: String(item.payload?.toolId ?? 'tool'),
          }
        }
        if (item?.type === 'plan') {
          return {
            event,
            loop,
            category: 'reasoning',
            summary: `plan ${String(item.payload?.title ?? '')}`.trim(),
          }
        }
        if (item?.type === 'approval') {
          return {
            event,
            loop,
            category: 'tool',
            summary: clip(String(item.payload?.title ?? '审批')),
          }
        }
        return {
          event,
          loop,
          category: 'system',
          summary: item?.type ?? event.eventType,
        }
      }
      case 'item.failed': {
        return {
          event,
          loop,
          category: 'system',
          summary: clip(String(payload.error ?? event.eventType)),
        }
      }
      case 'item.delta':
      case 'item.started':
        return undefined
      case 'approval.requested':
      case 'approval.resolved': {
        const approval = payload.approval as
          { title?: string; decision?: string } | undefined
        return {
          event,
          loop,
          category: 'tool',
          summary: clip(
            `${String(approval?.title ?? '')} ${approval?.decision ?? ''}`.trim(),
          ),
        }
      }
      case 'agent.checkpoint': {
        const digest = String(payload.stateDigest ?? '')
        return {
          event,
          loop,
          category: 'reasoning',
          summary: `checkpoint ${digest.slice(0, 12)}`,
        }
      }
      case 'turn.completed': {
        const turn = payload.turn as { output?: string } | undefined
        return {
          event,
          loop,
          category: 'system',
          summary: clip(String(turn?.output ?? 'turn completed')),
        }
      }
      case 'turn.failed':
      case 'turn.cancelled': {
        const turn = payload.turn as
          { error?: string; status?: string } | undefined
        return {
          event,
          loop,
          category: 'system',
          summary: clip(String(turn?.error ?? turn?.status ?? event.eventType)),
        }
      }
      default:
        return { event, loop, category: 'system', summary: event.eventType }
    }
  }

  if (streamId.startsWith('model-request:')) {
    switch (event.eventType) {
      case 'model.requested': {
        const p = payload as {
          model?: string
          stepIndex?: number
          attempt?: number
        }
        return {
          event,
          loop,
          category: 'llm',
          summary: `${String(p.model ?? 'model')} · step ${p.stepIndex ?? 0} · attempt ${p.attempt ?? 0}`,
        }
      }
      case 'model.completed': {
        const result = (
          payload as { result?: { stopReason?: string; usage?: unknown } }
        ).result
        const usage = (
          result as { usage?: { totalTokens?: number } } | undefined
        )?.usage
        return {
          event,
          loop,
          category: 'llm',
          summary: `${String(result?.stopReason ?? 'completed')}${usage?.totalTokens !== undefined ? ` · ${usage.totalTokens} tokens` : ''}`,
        }
      }
      case 'model.failed':
        return {
          event,
          loop,
          category: 'llm',
          summary: clip(String(payload.message ?? event.eventType)),
        }
      case 'context.manifest': {
        const manifest = (
          payload as {
            manifest?: {
              sections?: readonly { kind?: string }[]
              tokenBudget?: number
            }
          }
        ).manifest
        const kinds = new Set(
          (manifest?.sections ?? []).map((section) => section.kind ?? '?'),
        )
        return {
          event,
          loop,
          category: 'llm',
          summary:
            `sections=${manifest?.sections?.length ?? 0}` +
            ` · budget=${manifest?.tokenBudget ?? '?'} tokens` +
            ` · [${[...kinds].join(', ')}]`,
        }
      }
      default:
        return { event, loop, category: 'llm', summary: event.eventType }
    }
  }

  if (streamId.startsWith('execution:')) {
    switch (event.eventType) {
      case 'execution.permission_snapshot':
      case 'execution.started':
        return undefined
      case 'execution.requested': {
        const capability = (
          payload.request as { capability?: string } | undefined
        )?.capability
        return {
          event,
          loop,
          category: 'tool',
          summary: String(capability ?? 'action'),
        }
      }
      case 'execution.authorized':
      case 'execution.denied': {
        const p = payload as { decision?: string; reason?: string }
        return {
          event,
          loop,
          category: 'tool',
          summary: clip(
            `${String(p.decision ?? '')} ${String(p.reason ?? '')}`.trim(),
          ),
        }
      }
      case 'execution.approval_required': {
        const p = payload as { title?: string }
        return {
          event,
          loop,
          category: 'tool',
          summary: clip(`审批 ${String(p.title ?? '')}`.trim()),
        }
      }
      case 'execution.completed': {
        const result = (payload as { result?: { isError?: boolean } }).result
        return {
          event,
          loop,
          category: 'tool',
          summary: result?.isError === true ? 'completed (error)' : 'completed',
        }
      }
      case 'execution.failed':
        return {
          event,
          loop,
          category: 'tool',
          summary: clip(String(payload.message ?? 'failed')),
        }
      default:
        return { event, loop, category: 'tool', summary: event.eventType }
    }
  }

  if (streamId === LEARNING_STREAM_ID) {
    switch (event.eventType) {
      case 'learning.loop.run': {
        const p = payload as {
          selectedTrajectories?: number
          derivedTurns?: number
          patternsFound?: number
          proposalsCreated?: readonly string[]
        }
        return {
          event,
          loop,
          category: 'reasoning',
          summary:
            `trajectories=${p.selectedTrajectories ?? 0} ` +
            `derived=${p.derivedTurns ?? 0} ` +
            `patterns=${p.patternsFound ?? 0} ` +
            `proposals=${p.proposalsCreated?.length ?? 0}`,
        }
      }
      case 'learning.proposal.created': {
        const proposal = (
          payload as {
            proposal?: { hypothesis?: string; type?: string }
          }
        ).proposal
        return {
          event,
          loop,
          category: 'proposal',
          summary: clip(
            `${String(proposal?.type ?? 'proposal')}: ${String(proposal?.hypothesis ?? '')}`,
          ),
        }
      }
      case 'learning.proposal.status_changed': {
        const p = payload as { from?: string; to?: string }
        return {
          event,
          loop,
          category: 'proposal',
          summary: `${String(p.from ?? '?')} → ${String(p.to ?? '?')}`,
        }
      }
      case 'learning.experiment.started': {
        const p = payload as { evaluatorId?: string }
        return {
          event,
          loop,
          category: 'proposal',
          summary: `experiment ${String(p.evaluatorId ?? '')}`.trim(),
        }
      }
      case 'learning.experiment.completed': {
        const p = payload as {
          verdict?: string
          metrics?: Record<string, number>
        }
        const metrics = Object.entries(p.metrics ?? {})
          .map(([key, value]) => `${key}=${value}`)
          .join(' ')
        return {
          event,
          loop,
          category: 'proposal',
          summary: clip(
            `verdict=${String(p.verdict ?? '?')} ${metrics}`.trim(),
          ),
        }
      }
      case 'learning.experiment.failed':
        return {
          event,
          loop,
          category: 'proposal',
          summary: clip(String(payload.message ?? 'experiment failed')),
        }
      case 'learning.proposal.activated': {
        const p = payload as { via?: string; claimId?: string }
        return {
          event,
          loop,
          category: 'proposal',
          summary: `activated via ${String(p.via ?? '?')} (${String(p.claimId ?? '').slice(0, 8)})`,
        }
      }
      case 'learning.proposal.activation-reverted':
        return {
          event,
          loop,
          category: 'proposal',
          summary: clip(
            `reverted ${String(payload.reason ?? '')}`.trim() || 'reverted',
          ),
        }
      case 'learning.drift.checked': {
        const checked = (payload as { checked?: readonly unknown[] }).checked
        const rolled = (
          payload as { checked?: readonly { rolledBack?: boolean }[] }
        ).checked?.filter((item) => item.rolledBack === true).length
        return {
          event,
          loop,
          category: 'proposal',
          summary: `checked=${checked?.length ?? 0}${rolled ? ` rolled_back=${rolled}` : ''}`,
        }
      }
      default:
        return { event, loop, category: 'proposal', summary: event.eventType }
    }
  }

  if (streamId === MEMORY_STREAM_ID) {
    switch (event.eventType) {
      case 'memory.claim.recorded': {
        const claim = (
          payload as { claim?: { statement?: string; kind?: string } }
        ).claim
        return {
          event,
          loop,
          category: 'memory',
          summary: clip(
            `${String(claim?.kind ?? 'claim')}: ${String(claim?.statement ?? '')}`,
          ),
        }
      }
      case 'memory.claim.superseded':
      case 'memory.claim.retracted': {
        const p = payload as { claimId?: string; reason?: string }
        return {
          event,
          loop,
          category: 'memory',
          summary: clip(
            `${String(p.claimId ?? '').slice(0, 8)} ${String(p.reason ?? '')}`.trim(),
          ),
        }
      }
      case 'memory.observation.recorded': {
        const observation = (payload as { observation?: { content?: string } })
          .observation
        return {
          event,
          loop,
          category: 'memory',
          summary: clip(`观察: ${String(observation?.content ?? '')}`.trim()),
        }
      }
      case 'memory.consolidation.completed': {
        const p = payload as {
          considered?: number
          merged?: readonly unknown[]
        }
        return {
          event,
          loop,
          category: 'memory',
          summary: `considered=${p.considered ?? 0} merged=${p.merged?.length ?? 0}`,
        }
      }
      case 'memory.health.changed': {
        const p = payload as { from?: string; to?: string; detail?: string }
        return {
          event,
          loop,
          category: 'memory',
          summary: clip(
            `${String(p.from ?? '')} → ${String(p.to ?? '')} ${String(p.detail ?? '')}`.trim(),
          ),
        }
      }
      default:
        return { event, loop, category: 'memory', summary: event.eventType }
    }
  }

  if (streamId === SCHEDULER_STREAM_ID) {
    if (event.eventType === 'scheduler.trigger.triggered') {
      const p = payload as {
        triggerId?: string
        status?: string
        missedIntervals?: number
      }
      return {
        event,
        loop,
        category: 'system',
        summary: clip(
          `status=${String(p.status ?? '?')}` +
            (p.missedIntervals ? ` 追赶 ${p.missedIntervals} 次` : ''),
        ),
      }
    }
    if (event.eventType === 'scheduler.trigger.registered') {
      const trigger = (
        payload as {
          trigger?: {
            input?: string
            intervalMs?: number
            when?: { taskStatus?: string }
          }
        }
      ).trigger
      const cadence = trigger?.when?.taskStatus
        ? `当任务进入 ${trigger.when.taskStatus}`
        : trigger?.intervalMs !== undefined
          ? `每 ${Math.round(trigger.intervalMs / 60_000)} 分钟`
          : '一次性'
      return {
        event,
        loop,
        category: 'system',
        summary: clip(
          `注册触发器（${cadence}）：${String(trigger?.input ?? '')}`,
        ),
      }
    }
    const p = payload as { triggerId?: string }
    return {
      event,
      loop,
      category: 'system',
      summary: `移除触发器 ${String(p.triggerId ?? '').slice(0, 8)}`,
    }
  }

  if (streamId === STRUCTURE_STREAM_ID) {
    const p = payload as {
      digest?: string
      phase?: string
      pluginIds?: string[]
    }
    return {
      event,
      loop,
      category: 'system',
      summary: clip(
        `${String(p.phase ?? event.eventType.replace('structure.', ''))} ${String(p.digest ?? '').slice(0, 12)}`.trim(),
      ),
    }
  }

  if (streamId === WORLD_STREAM_ID) {
    if (event.eventType === 'world.entity.recorded') {
      const entity = (payload as { entity?: { kind?: string; id?: string } })
        .entity
      return {
        event,
        loop,
        category: 'system',
        summary:
          `实体 ${String(entity?.kind ?? '')} ${String(entity?.id ?? '').slice(0, 24)}`.trim(),
      }
    }
    if (event.eventType === 'world.relation.projected') {
      const relation = (
        payload as { relation?: { type?: string; fromEntityId?: string } }
      ).relation
      return {
        event,
        loop,
        category: 'system',
        summary:
          `关系 ${String(relation?.type ?? '')} ${String(relation?.fromEntityId ?? '').slice(0, 24)}`.trim(),
      }
    }
    const version = (payload as { version?: number }).version
    return {
      event,
      loop,
      category: 'system',
      summary: `世界版本 v${version ?? '?'}`,
    }
  }

  // Future plugin streams: visible, never silently dropped.
  return {
    event,
    loop,
    category: 'system',
    summary: event.eventType,
  }
}

/**
 * Builds the global trajectory timeline (architecture §7.4 observability):
 * every stream's recent window, classified into fast/slow loops and
 * user-facing categories, newest first. Per-stream reads are bounded by the
 * page size, so the scan stays O(streams × limit) however long the history
 * grows.
 */
export async function buildGlobalTrajectory(
  store: ChronicleStore,
  query: GlobalTrajectoryQuery = {},
): Promise<GlobalTrajectory> {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500)
  const streams = await store.listStreams()
  const drafts: EntryDraft[] = []

  for (const streamId of streams) {
    if (query.streamId !== undefined && streamId !== query.streamId) continue
    const latest = await store.getLatestSequence(streamId)
    if (latest === 0) continue
    const after = Math.max(0, latest - limit)
    for await (const event of store.readStream(streamId, after)) {
      const draft = classify(streamId, event)
      if (draft !== undefined) drafts.push(draft)
    }
  }

  const counts = {
    fast: 0,
    slow: 0,
    byCategory: {
      input: 0,
      llm: 0,
      tool: 0,
      memory: 0,
      reasoning: 0,
      proposal: 0,
      system: 0,
    } as Record<TrajectoryCategory, number>,
  }
  for (const draft of drafts) {
    counts[draft.loop] += 1
    counts.byCategory[draft.category] += 1
  }

  drafts.sort((a, b) => {
    if (a.event.eventTime !== b.event.eventTime) {
      return a.event.eventTime < b.event.eventTime ? 1 : -1
    }
    if (a.event.streamId !== b.event.streamId) {
      return a.event.streamId < b.event.streamId ? -1 : 1
    }
    return b.event.sequence - a.event.sequence
  })

  const entries: TrajectoryEntry[] = []
  for (const draft of drafts) {
    if (query.loop !== undefined && draft.loop !== query.loop) continue
    if (query.category !== undefined && draft.category !== query.category) {
      continue
    }
    if (entries.length === limit) break
    const budget = { left: 16_384 }
    entries.push({
      eventId: draft.event.eventId,
      streamId: draft.event.streamId,
      sequence: draft.event.sequence,
      eventTime: draft.event.eventTime,
      eventType: draft.event.eventType,
      loop: draft.loop,
      category: draft.category,
      summary: draft.summary,
      threadId: draft.event.threadId,
      turnId: draft.event.turnId,
      detail: trimDetail(draft.event.payload, budget) as Record<
        string,
        unknown
      >,
    })
  }

  return { entries, counts, scannedStreams: streams.length }
}
