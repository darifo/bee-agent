import { describe, expect, it } from 'vitest'
import { ChronicleSchemaRegistry } from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import { registerThreadChronicleEvents } from '@bee-agent/thread'
import {
  ChronicleKanbanStore,
  KanbanDispatcher,
  registerKanbanChronicleEvents,
} from '@bee-agent/kanban'
import { createFakeLlmRuntime } from '@bee-agent/runtime/testing'
import type { FakeLlmStep } from '@bee-agent/runtime/testing'
import type { AgentLoopToolSlot } from '@bee-agent/runtime'
import { buildBeeServer } from '../src/index.ts'
import type { BeeServer } from '../src/index.ts'
import type { KanbanStore, KanbanTask } from '@bee-agent/kanban'

const NOW = '2026-08-25T10:00:00.000Z'

function createRegistry(): ChronicleSchemaRegistry {
  const registry = new ChronicleSchemaRegistry()
  registerThreadChronicleEvents(registry)
  registerKanbanChronicleEvents(registry)
  return registry
}

const noopTools: AgentLoopToolSlot = {
  async execute() {
    return { kind: 'result', output: {}, content: 'noop' }
  },
}

async function startServer(
  kanban: KanbanStore,
  script: readonly FakeLlmStep[] = [],
): Promise<{ server: BeeServer; baseUrl: string }> {
  const server = await buildBeeServer({
    store: new MemoryChronicleStore(createRegistry()),
    kanban,
    llm: createFakeLlmRuntime({ script }),
    tools: noopTools,
    logger: false,
  })
  await server.app.listen({ host: '127.0.0.1', port: 0 })
  await server.app.ready()
  const address = server.app.server.address()
  const port =
    address !== null && typeof address === 'object' ? address.port : 0
  return { server, baseUrl: `http://127.0.0.1:${port}` }
}

async function postJson(
  url: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: await response.json() }
}

async function getJson(
  url: string,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url)
  return { status: response.status, json: await response.json() }
}

async function patchJson(
  url: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: await response.json() }
}

describe('apps/bee /kanban API', () => {
  it('creates, lists, shows, updates, comments, and completes a task', async () => {
    const kanban = new ChronicleKanbanStore(
      new MemoryChronicleStore(createRegistry()),
    )
    const { server, baseUrl } = await startServer(kanban)
    try {
      const created = await postJson(`${baseUrl}/kanban/tasks`, {
        title: 'Write release notes',
        priority: 'high',
      })
      expect(created.status).toBe(201)
      const task = created.json as KanbanTask
      expect(task.status).toBe('inbox')

      const listed = await getJson(`${baseUrl}/kanban/tasks?status=inbox`)
      expect(listed.json as KanbanTask[]).toHaveLength(1)

      const shown = await getJson(`${baseUrl}/kanban/tasks/${task.id}`)
      expect((shown.json as KanbanTask).title).toBe('Write release notes')

      const updated = await patchJson(`${baseUrl}/kanban/tasks/${task.id}`, {
        title: 'Write the release notes',
      })
      expect((updated.json as KanbanTask).title).toBe('Write the release notes')

      const commented = await postJson(
        `${baseUrl}/kanban/tasks/${task.id}/comment`,
        { body: 'Looking good', author: 'user' },
      )
      expect((commented.json as KanbanTask).comments).toHaveLength(1)

      // Drive the task to running via the shared store, then complete via REST.
      // Read the current version each step (update/comment already advanced it).
      let version = (await kanban.get(task.id))?.version ?? 1
      await kanban.transition(task.id, {
        to: 'triaged',
        expectedVersion: version,
        at: NOW,
      })
      version = (await kanban.get(task.id))?.version ?? 1
      await kanban.transition(task.id, {
        to: 'ready',
        expectedVersion: version,
        at: NOW,
      })
      version = (await kanban.get(task.id))?.version ?? 1
      await kanban.transition(task.id, {
        to: 'running',
        expectedVersion: version,
        at: NOW,
      })
      const completed = await postJson(
        `${baseUrl}/kanban/tasks/${task.id}/complete`,
        {},
      )
      expect((completed.json as KanbanTask).status).toBe('done')
    } finally {
      await server.app.close()
    }
  })

  it('returns 404 for a missing task', async () => {
    const kanban = new ChronicleKanbanStore(
      new MemoryChronicleStore(createRegistry()),
    )
    const { server, baseUrl } = await startServer(kanban)
    try {
      const missing = await getJson(
        `${baseUrl}/kanban/tasks/11111111-1111-4111-8111-111111111111`,
      )
      expect(missing.status).toBe(404)
    } finally {
      await server.app.close()
    }
  })
})

describe('apps/bee kanban agent tool ↔ dispatcher', () => {
  it('a task created in conversation is claimed and completed by the background dispatcher, then survives a restart', async () => {
    const registry = createRegistry()
    const chronicle = new MemoryChronicleStore(registry)
    const kanban = new ChronicleKanbanStore(chronicle)

    const script: readonly FakeLlmStep[] = [
      {
        type: 'respond',
        deltas: ['Let me track that.'],
        toolCalls: [
          {
            callId: 'c1',
            toolId: 'kanban_create',
            input: { title: 'Ship the report' },
          },
        ],
      },
      { type: 'respond', deltas: ['Created.'] },
    ]
    const { server, baseUrl } = await startServer(kanban, script)
    try {
      const threadResponse = await postJson(`${baseUrl}/threads`, {})
      const thread = threadResponse.json as { id: string }
      const turn = await postJson(`${baseUrl}/threads/${thread.id}/turns`, {
        input: 'Please track shipping the report',
      })
      expect((turn.json as { status: string }).status).toBe('completed')

      // The agent tool created the task in the shared store.
      const tasks = await kanban.list()
      expect(tasks).toHaveLength(1)
      const taskId = tasks[0]?.id
      expect(tasks[0]?.status).toBe('inbox')

      // Bidirectional link: the task records its source thread/turn/item, and
      // the store resolves thread/item → task in one hop.
      expect(tasks[0]?.source?.threadId).toBe(thread.id)
      expect(tasks[0]?.source?.turnId).toBeDefined()
      expect(tasks[0]?.source?.itemId).toBeDefined()
      const byThread = await kanban.list({ sourceThreadId: thread.id })
      expect(byThread.map((task) => task.id)).toEqual([taskId])
      const byItem = await kanban.list({
        sourceItemId: tasks[0]?.source?.itemId,
      })
      expect(byItem.map((task) => task.id)).toEqual([taskId])

      // The background dispatcher claims and completes it after triage.
      await kanban.transition(taskId!, {
        to: 'triaged',
        expectedVersion: 1,
        at: NOW,
      })
      await kanban.transition(taskId!, {
        to: 'ready',
        expectedVersion: 2,
        at: NOW,
      })
      const dispatcher = new KanbanDispatcher(kanban, {
        leaseDurationMs: 60_000,
      })
      const claimed = await dispatcher.claimNext('background', NOW)
      expect(claimed?.id).toBe(taskId)
      await dispatcher.complete(taskId!, claimed!.claim!.leaseId, NOW)

      // A fresh store over the same durable log recovers the completed task.
      const restarted = new ChronicleKanbanStore(chronicle)
      await restarted.rebuild()
      const recovered = await restarted.get(taskId!)
      expect(recovered?.status).toBe('done')
    } finally {
      await server.app.close()
    }
  })
})
