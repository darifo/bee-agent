import Database from 'better-sqlite3'
import type { ChronicleStore, NewChronicleEvent } from '@bee-agent/knowledge'
import { newChronicleEvent } from '@bee-agent/knowledge'
/** The Chronicle stream id holding one thread's events (mirrors @bee-agent/thread). */
function threadStreamId(threadId: string): string {
  return `thread:${threadId}`
}

/**
 * The v0 → v1 import tool (v1 refactor plan §5.7 WF6-C, ADR 0031 clean
 * break): an explicit, one-way migration turning a v0 SQLite event store
 * into v1 Chronicle streams. Each v0 task becomes one thread with one
 * migrated turn; events map by semantics (agent messages → message items,
 * tool traffic → tool_call items, approvals → approval items, lifecycle →
 * turn events). The v0 file is opened read-only; everything produced lands
 * on the v1 append-only log with `v0-import` provenance. Re-running is
 * safe: threads whose v1 streams already exist are skipped and reported.
 */

export interface ImportSummary {
  readonly tasksImported: number
  readonly tasksSkipped: number
  readonly eventsRead: number
  readonly eventsImported: number
}

interface ItemDraft {
  id: string
  type: 'message' | 'tool_call' | 'approval'
  payload: Record<string, unknown>
}

interface TaskDraft {
  threadId: string
  turnId: string
  createdAt: string
  status: 'active' | 'completed' | 'failed' | 'cancelled'
  output: string | undefined
  error: string | undefined
  open: ItemDraft[]
  events: NewChronicleEvent[]
}

const IMPORT_ACTOR = { type: 'system' as const, id: 'v0-import' }

function started(
  task: TaskDraft,
  item: ItemDraft,
  at: string,
): NewChronicleEvent {
  return newChronicleEvent({
    eventType: 'item.started',
    actor: IMPORT_ACTOR,
    threadId: task.threadId,
    turnId: task.turnId,
    payload: {
      item: {
        id: item.id,
        threadId: task.threadId,
        turnId: task.turnId,
        status: 'active',
        type: item.type,
        createdAt: at,
        payload: item.payload,
      },
    },
  })
}

function completed(
  task: TaskDraft,
  item: ItemDraft,
  at: string,
): NewChronicleEvent {
  return newChronicleEvent({
    eventType: 'item.completed',
    actor: IMPORT_ACTOR,
    threadId: task.threadId,
    turnId: task.turnId,
    payload: {
      item: {
        id: item.id,
        threadId: task.threadId,
        turnId: task.turnId,
        status: 'completed',
        type: item.type,
        createdAt: at,
        endedAt: at,
        payload: item.payload,
      },
    },
  })
}

function emitMessage(
  task: TaskDraft,
  role: string,
  content: string,
  at: string,
): void {
  const item: ItemDraft = {
    id: crypto.randomUUID(),
    type: 'message',
    payload: { role, content },
  }
  task.events.push(started(task, item, at), completed(task, item, at))
}

/** One pass over v0 rows → fully-formed v1 thread streams. */
function convert(
  rows: readonly {
    taskId: string
    sequence: number
    type: string
    payload: unknown
    createdAt: string
  }[],
): Map<string, TaskDraft> {
  const tasks = new Map<string, TaskDraft>()
  const ordered = [...rows].sort(
    (a, b) => a.taskId.localeCompare(b.taskId) || a.sequence - b.sequence,
  )

  for (const row of ordered) {
    let task = tasks.get(row.taskId)
    if (task === undefined) {
      task = {
        // v0 task ids are uuids and unique per task: reuse as the thread id
        // so re-imports are naturally idempotent per stream.
        threadId: row.taskId,
        turnId: crypto.randomUUID(),
        createdAt: row.createdAt,
        status: 'active',
        output: undefined,
        error: undefined,
        open: [],
        events: [
          newChronicleEvent({
            eventType: 'thread.created',
            actor: IMPORT_ACTOR,
            threadId: row.taskId,
            payload: {
              thread: {
                id: row.taskId,
                title: 'Imported from v0',
                createdAt: row.createdAt,
                updatedAt: row.createdAt,
              },
            },
          }),
          newChronicleEvent({
            eventType: 'turn.started',
            actor: IMPORT_ACTOR,
            threadId: row.taskId,
            turnId: undefined as never,
            payload: {},
          }),
        ],
      }
      // Rebuild turn.started with the real turnId (created above).
      task.events[1] = newChronicleEvent({
        eventType: 'turn.started',
        actor: IMPORT_ACTOR,
        threadId: task.threadId,
        turnId: task.turnId,
        payload: {
          turn: {
            id: task.turnId,
            threadId: task.threadId,
            status: 'active',
            trigger: 'user',
            startedAt: task.createdAt,
          },
        },
      })
      tasks.set(row.taskId, task)
    }

    const payload = (row.payload ?? {}) as Record<string, unknown>
    const at = row.createdAt || task.createdAt

    switch (row.type) {
      case 'task.created': {
        const spec = payload.spec as { input?: string } | undefined
        emitMessage(task, 'user', spec?.input ?? '', at)
        break
      }
      case 'agent.message': {
        const role =
          typeof payload.role === 'string' ? payload.role : 'assistant'
        if (role === 'user' || role === 'system') break
        const content =
          typeof payload.content === 'string' ? payload.content : ''
        emitMessage(task, 'assistant', content, at)
        break
      }
      case 'tool.call': {
        const call = payload as {
          toolId?: string
          id?: string
          arguments?: unknown
        }
        const item: ItemDraft = {
          id: crypto.randomUUID(),
          type: 'tool_call',
          payload: {
            toolId: typeof call.toolId === 'string' ? call.toolId : 'unknown',
            callId: typeof call.id === 'string' ? call.id : crypto.randomUUID(),
            input: call.arguments ?? {},
          },
        }
        task.open.push(item)
        task.events.push(started(task, item, at))
        break
      }
      case 'tool.result': {
        const result = payload as {
          callId?: string
          output?: unknown
          error?: string
        }
        const index = task.open.findIndex(
          (item) =>
            item.type === 'tool_call' &&
            (result.callId === undefined ||
              item.payload.callId === result.callId),
        )
        if (index === -1) break
        const removed = task.open.splice(index, 1)[0] as ItemDraft
        const item = removed
        item.payload = {
          ...item.payload,
          output: result.output ?? {},
          content:
            result.error !== undefined
              ? result.error
              : typeof result.output === 'string'
                ? result.output
                : JSON.stringify(result.output ?? {}),
          ...(result.error !== undefined ? { isError: true } : {}),
        }
        task.events.push(completed(task, item, at))
        break
      }
      case 'approval.requested': {
        const item: ItemDraft = {
          id: crypto.randomUUID(),
          type: 'approval',
          payload: {
            title:
              typeof payload.message === 'string'
                ? payload.message
                : 'v0 approval',
            detail: '',
            status: 'pending',
            approvalId:
              typeof payload.approvalId === 'string'
                ? payload.approvalId
                : crypto.randomUUID(),
          },
        }
        task.open.push(item)
        task.events.push(started(task, item, at))
        break
      }
      case 'approval.decided': {
        const index = task.open.findIndex((item) => item.type === 'approval')
        if (index === -1) break
        const approvalItem = task.open.splice(index, 1)[0] as ItemDraft
        approvalItem.payload = {
          ...approvalItem.payload,
          status: payload.approved === true ? 'approved' : 'rejected',
        }
        task.events.push(completed(task, approvalItem, at))
        break
      }
      case 'task.completed': {
        task.status = 'completed'
        task.output =
          typeof payload.result === 'string'
            ? payload.result
            : JSON.stringify(payload.result ?? '')
        break
      }
      case 'task.failed': {
        task.status = 'failed'
        task.error =
          typeof payload.error === 'string' ? payload.error : 'v0 task failed'
        break
      }
      case 'task.cancelled': {
        task.status = 'cancelled'
        break
      }
      default:
        // task.started/suspended/resumed are represented by v1 item and
        // turn lifecycle; unknown custom types are dropped with the counts
        // in the summary showing the difference.
        break
    }
  }

  // Close each thread with the terminal turn state (or leave active).
  for (const task of tasks.values()) {
    const terminal = task.status !== 'active'
    const turn = {
      id: task.turnId,
      threadId: task.threadId,
      status: task.status,
      trigger: 'user' as const,
      startedAt: task.createdAt,
      ...(terminal ? { endedAt: task.createdAt } : {}),
    }
    if (task.status === 'completed') {
      task.events.push(
        newChronicleEvent({
          eventType: 'turn.completed',
          actor: IMPORT_ACTOR,
          threadId: task.threadId,
          turnId: task.turnId,
          payload: { turn },
        }),
      )
    } else if (task.status === 'failed') {
      task.events.push(
        newChronicleEvent({
          eventType: 'turn.failed',
          actor: IMPORT_ACTOR,
          threadId: task.threadId,
          turnId: task.turnId,
          payload: {
            turn,
            error: task.error ?? 'v0 task failed',
          },
        }),
      )
    } else if (task.status === 'cancelled') {
      task.events.push(
        newChronicleEvent({
          eventType: 'turn.cancelled',
          actor: IMPORT_ACTOR,
          threadId: task.threadId,
          turnId: task.turnId,
          payload: { turn },
        }),
      )
    }
  }
  return tasks
}

/**
 * Imports a v0 SQLite event store into the v1 Chronicle. The file is
 * opened read-only; each converted task appends one `thread:<id>` stream.
 */
export async function importV0Database(options: {
  readonly path: string
  readonly store: ChronicleStore
}): Promise<ImportSummary> {
  const db = new Database(options.path, { readonly: true, fileMustExist: true })
  try {
    const rows = db
      .prepare(
        'SELECT task_id AS taskId, sequence, type, payload, created_at AS createdAt FROM agent_events ORDER BY task_id, sequence',
      )
      .all() as unknown as {
      taskId: string
      sequence: number
      type: string
      payload: string
      createdAt: string
    }[]
    const parsed = rows.map((row) => ({
      taskId: row.taskId,
      sequence: row.sequence,
      type: row.type,
      payload: JSON.parse(row.payload) as unknown,
      createdAt: row.createdAt,
    }))

    const tasks = convert(parsed)
    let tasksImported = 0
    let tasksSkipped = 0
    let eventsImported = 0
    for (const task of tasks.values()) {
      const streamId = threadStreamId(task.threadId)
      if ((await options.store.getLatestSequence(streamId)) > 0) {
        tasksSkipped += 1
        continue
      }
      await options.store.append(streamId, task.events, { expectedSequence: 1 })
      tasksImported += 1
      eventsImported += task.events.length
    }
    return {
      tasksImported,
      tasksSkipped,
      eventsRead: parsed.length,
      eventsImported,
    }
  } finally {
    db.close()
  }
}
