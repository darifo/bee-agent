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
})
