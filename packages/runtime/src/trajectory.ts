import type { ChronicleStore } from '@bee-agent/knowledge'
import { readThreadEvents } from '@bee-agent/thread'
import { executionStreamId } from '@bee-agent/execution'
import { rebuildModelRequest } from './model-request-service.ts'
import type { RebuiltModelRequest } from './model-request-service.ts'

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
