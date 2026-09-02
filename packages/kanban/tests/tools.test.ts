import { describe, expect, it } from 'vitest'
import { ChronicleSchemaRegistry } from '@bee-agent/knowledge'
import {
  KANBAN_TOOL_DEFINITIONS,
  createKanbanToolExecutor,
  registerKanbanChronicleEvents,
} from '../src/index.ts'
import type { KanbanTask } from '../src/index.ts'
import { createMemoryKanbanStore } from '../src/testing.ts'

function createExecutor() {
  const registry = new ChronicleSchemaRegistry()
  registerKanbanChronicleEvents(registry)
  return createKanbanToolExecutor(createMemoryKanbanStore(registry))
}

describe('kanban tools', () => {
  it('exposes the eight architecture tool ids', () => {
    expect(KANBAN_TOOL_DEFINITIONS.map((definition) => definition.id)).toEqual([
      'kanban_create',
      'kanban_list',
      'kanban_show',
      'kanban_update',
      'kanban_block',
      'kanban_comment',
      'kanban_complete',
      'kanban_cancel',
    ])
  })

  it('creates, shows, lists, updates, and comments a task', async () => {
    const executor = createExecutor()
    const created = await executor.execute({
      toolId: 'kanban_create',
      input: { title: 'Write docs', priority: 'high' },
    })
    const task = created.output as KanbanTask
    expect(task.status).toBe('inbox')
    expect(task.priority).toBe('high')

    const shown = await executor.execute({
      toolId: 'kanban_show',
      input: { id: task.id },
    })
    expect((shown.output as KanbanTask).title).toBe('Write docs')

    const listed = await executor.execute({
      toolId: 'kanban_list',
      input: { status: 'inbox' },
    })
    expect(listed.output as KanbanTask[]).toHaveLength(1)

    const updated = await executor.execute({
      toolId: 'kanban_update',
      input: { id: task.id, title: 'Write more docs' },
    })
    expect((updated.output as KanbanTask).title).toBe('Write more docs')

    const commented = await executor.execute({
      toolId: 'kanban_comment',
      input: { id: task.id, body: 'Nice', author: 'bee' },
    })
    expect((commented.output as KanbanTask).comments).toHaveLength(1)
  })

  it('cancels a task', async () => {
    const executor = createExecutor()
    const created = await executor.execute({
      toolId: 'kanban_create',
      input: { title: 'Drop me' },
    })
    const task = created.output as KanbanTask

    const cancelled = await executor.execute({
      toolId: 'kanban_cancel',
      input: { id: task.id },
    })
    expect((cancelled.output as KanbanTask).status).toBe('cancelled')
  })

  it('rejects a missing task id', async () => {
    const executor = createExecutor()
    await expect(
      executor.execute({ toolId: 'kanban_show', input: { id: '' } }),
    ).rejects.toThrow(/non-empty string/)
  })

  it('records source provenance when given conversation context', async () => {
    const executor = createExecutor()
    const threadId = crypto.randomUUID()
    const turnId = crypto.randomUUID()
    const itemId = crypto.randomUUID()
    const created = await executor.execute({
      toolId: 'kanban_create',
      input: { title: 'Linked' },
      context: { threadId, turnId, itemId },
    })
    expect((created.output as KanbanTask).source).toEqual({
      threadId,
      turnId,
      itemId,
    })
  })
})

describe('kanban complete path', () => {
  it('walks the shortest legal chain from inbox to done in one call', async () => {
    const registry = new ChronicleSchemaRegistry()
    registerKanbanChronicleEvents(registry)
    const store = createMemoryKanbanStore(registry)
    const executor = createKanbanToolExecutor(store)
    const created = await executor.execute({
      toolId: 'kanban_create',
      input: { title: '一键完成' },
    })
    const task = created.output as KanbanTask

    const completed = await executor.execute({
      toolId: 'kanban_complete',
      input: { id: task.id },
    })
    expect((completed.output as KanbanTask).status).toBe('done')

    // Every hop bumps the version (create=1, then triaged/ready/running/
    // done) — the durable walk happened step by step, not a teleport, and
    // the healthy lifecycle won over any failed/cancelled shortcut.
    const done = completed.output as KanbanTask
    expect(done.version).toBe(5)
    expect(await store.get(task.id)).toMatchObject({ status: 'done' })
  })

  it('still reports legal targets when the target is unreachable', async () => {
    const executor = createExecutor()
    const created = await executor.execute({
      toolId: 'kanban_create',
      input: { title: '已归档' },
    })
    const task = created.output as KanbanTask
    await executor.execute({ toolId: 'kanban_cancel', input: { id: task.id } })
    await expect(
      executor.execute({ toolId: 'kanban_complete', input: { id: task.id } }),
    ).rejects.toThrow(/legal targets from 'cancelled': archived/)
  })
})
