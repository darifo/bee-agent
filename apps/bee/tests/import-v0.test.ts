import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ChronicleSchemaRegistry,
  registerMemoryChronicleEvents,
  registerStructureChronicleEvents,
  registerWorldChronicleEvents,
} from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import { registerThreadChronicleEvents } from '@bee-agent/thread'
import { registerRuntimeChronicleEvents } from '@bee-agent/runtime'
import { registerKanbanChronicleEvents } from '@bee-agent/kanban'
import { createMemoryKanbanStore } from '@bee-agent/kanban/testing'
import { registerLearningChronicleEvents } from '@bee-agent/learning'
import { createFakeLlmRuntime } from '@bee-agent/runtime/testing'
import { buildBeeServer } from '../src/index.ts'
import type { BeeServer } from '../src/index.ts'

const V0_DDL = `
CREATE TABLE IF NOT EXISTS task_sequences (
  task_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0)
);
CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, sequence)
);
`

function v0Database(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'bee-v0-'))
  const path = join(dir, 'v0.db')
  const db = new Database(path)
  db.exec(V0_DDL)
  const insert = db.prepare(
    'INSERT INTO agent_events (id, task_id, sequence, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const taskId = crypto.randomUUID()
  const at = '2026-08-20T10:00:00.000Z'
  const callId = crypto.randomUUID()
  const rows: [string, number, string, unknown][] = [
    [
      'task.created',
      1,
      'task.created',
      {
        spec: {
          id: taskId,
          input: 'Summarize the report',
          agentId: 'a',
          metadata: {},
        },
        state: 'pending',
      },
    ],
    [
      'agent.message',
      2,
      'agent.message',
      { role: 'assistant', content: 'Reading it now.' },
    ],
    [
      'tool.call',
      3,
      'tool.call',
      {
        id: callId,
        taskId,
        toolId: 'fs.read',
        arguments: { path: '/tmp/report' },
      },
    ],
    ['tool.result', 4, 'tool.result', { callId, output: 'the report text' }],
    [
      'approval.requested',
      5,
      'approval.requested',
      { approvalId: crypto.randomUUID(), message: 'Run fs.read?' },
    ],
    ['approval.decided', 6, 'approval.decided', { approved: true }],
    [
      'agent.message',
      7,
      'agent.message',
      { role: 'assistant', content: 'Here is the summary.' },
    ],
    [
      'task.completed',
      8,
      'task.completed',
      { state: 'completed', result: 'Here is the summary.' },
    ],
  ]
  let sequence = 0
  for (const [type, , payloadType, payload] of rows) {
    sequence += 1
    insert.run(
      crypto.randomUUID(),
      taskId,
      sequence,
      payloadType,
      JSON.stringify(payload),
      at,
    )
    void type
  }
  db.close()
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function createRegistryStore(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerStructureChronicleEvents(registry)
  registerThreadChronicleEvents(registry)
  registerRuntimeChronicleEvents(registry)
  registerKanbanChronicleEvents(registry)
  registerMemoryChronicleEvents(registry)
  registerWorldChronicleEvents(registry)
  registerLearningChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

async function withServer(
  fn: (server: BeeServer, baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = await buildBeeServer({
    store: createRegistryStore(),
    kanban: createMemoryKanbanStore(
      (() => {
        const registry = new ChronicleSchemaRegistry()
        registerKanbanChronicleEvents(registry)
        return registry
      })(),
    ),
    llm: createFakeLlmRuntime({ script: [] }),
    logger: false,
  })
  await server.app.listen({ host: '127.0.0.1', port: 0 })
  await server.app.ready()
  try {
    await fn(
      server,
      `http://127.0.0.1:${(server.app.server.address() as { port: number }).port}`,
    )
  } finally {
    await server.app.close()
  }
}

describe('v0 import (WF6-C)', () => {
  it('converts a v0 task into a complete v1 thread and is idempotent', async () => {
    const v0 = v0Database()
    try {
      await withServer(async (server, baseUrl) => {
        const first = (await (
          await fetch(`${baseUrl}/import/v0`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: v0.path }),
          })
        ).json()) as {
          tasksImported: number
          tasksSkipped: number
          eventsRead: number
          eventsImported: number
        }
        expect(first.tasksImported).toBe(1)
        expect(first.tasksSkipped).toBe(0)
        expect(first.eventsRead).toBe(8)
        expect(first.eventsImported).toBeGreaterThan(8)

        // The v1 thread holds the full migrated shape.
        const streams = await server.store.listStreams()
        const threadStream = streams.find((id) => id.startsWith('thread:'))!
        const types: string[] = []
        for await (const event of server.store.readStream(threadStream)) {
          types.push(event.eventType)
        }
        expect(types).toContain('thread.created')
        expect(types).toContain('turn.started')
        expect(types).toContain('turn.completed')
        // user + 2 assistant messages, tool_call started/completed, approval started/completed
        // user msg + 2 assistant msgs + tool_call + approval = 5 items
        expect(types.filter((t) => t === 'item.started')).toHaveLength(5)
        expect(types.filter((t) => t === 'item.completed')).toHaveLength(5)

        // Tool result carried content; approval got the decision.
        let toolContent = ''
        let approvalStatus = ''
        for await (const event of server.store.readStream(threadStream)) {
          if (event.eventType !== 'item.completed') continue
          const item = (
            event.payload as {
              item: { type: string; payload: Record<string, unknown> }
            }
          ).item
          if (item.type === 'tool_call')
            toolContent = String(item.payload.content)
          if (item.type === 'approval')
            approvalStatus = String(item.payload.status)
        }
        expect(toolContent).toBe('the report text')
        expect(approvalStatus).toBe('approved')

        // Re-import skips the already-present thread.
        const second = (await (
          await fetch(`${baseUrl}/import/v0`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: v0.path }),
          })
        ).json()) as { tasksImported: number; tasksSkipped: number }
        expect(second.tasksImported).toBe(0)
        expect(second.tasksSkipped).toBe(1)
      })
    } finally {
      v0.cleanup()
    }
  })

  it('reports a missing v0 database as 404', async () => {
    await withServer(async (_server, baseUrl) => {
      const response = await fetch(`${baseUrl}/import/v0`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/nonexistent/v0.db' }),
      })
      expect(response.status).toBe(404)
    })
  })
})
