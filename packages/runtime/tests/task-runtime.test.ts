import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createKernel, eventStoreService } from '@bee-agent/kernel'
import type { Kernel } from '@bee-agent/kernel'
import type { ToolResult } from '@bee-agent/contracts'
import {
  MockAgent,
  TaskRuntime,
  TaskRuntimeError,
  taskEventRecordedEvent,
} from '../src/index.js'
import type { Agent, Tool, TaskRuntimeOptions } from '../src/index.js'
import { MemoryEventStore } from './helpers/memory-event-store.js'

const echoTool: Tool = {
  manifest: {
    id: 'tools.echo',
    name: 'Echo',
    description: 'returns its input',
    inputSchema: {},
  },
  execute: (input) => input,
}

const failingTool: Tool = {
  manifest: {
    id: 'tools.failing',
    name: 'Failing',
    description: 'always throws',
    inputSchema: {},
  },
  execute: () => {
    throw new Error('kaboom')
  },
}

interface Fixture {
  kernel: Kernel
  store: MemoryEventStore
  runtime: TaskRuntime
}

const kernels: Kernel[] = []

async function setup(
  options: Omit<TaskRuntimeOptions, 'eventStore'> & {
    eventStore?: MemoryEventStore
  } = {},
): Promise<Fixture> {
  const kernel = createKernel()
  kernels.push(kernel)
  await kernel.start()
  const store = options.eventStore ?? new MemoryEventStore()
  const runtime = new TaskRuntime(kernel, {
    defaultAgent: new MockAgent(),
    ...options,
    eventStore: store,
  })
  return { kernel, store, runtime }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(async () => {
  while (kernels.length > 0) {
    const kernel = kernels.pop()!
    await kernel.stop()
  }
})

async function eventTypes(
  runtime: TaskRuntime,
  taskId: string,
): Promise<string[]> {
  const types: string[] = []
  for await (const event of runtime.readEvents(taskId)) {
    types.push(event.type)
  }
  return types
}

async function createSimpleTask(
  runtime: TaskRuntime,
  input = 'hello',
): Promise<string> {
  const spec = await runtime.createTask({
    input,
    agentId: 'agent.mock',
    metadata: {},
  })
  return spec.id
}

describe('task runtime', () => {
  it('creates pending tasks with generated ids', async () => {
    const { runtime } = await setup()
    const spec = await runtime.createTask({
      input: 'hello',
      agentId: 'agent.mock',
      metadata: {},
    })
    expect(spec.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(spec.metadata).toEqual({})
    const snapshot = await runtime.getSnapshot(spec.id)
    expect(snapshot.state).toBe('pending')
    expect(snapshot.spec).toEqual(spec)
  })

  it('rejects invalid creation requests', async () => {
    const { runtime } = await setup()
    await expect(
      runtime.createTask({ input: '', agentId: 'agent.mock', metadata: {} }),
    ).rejects.toThrow()
  })

  it('runs a task to completion and records the event stream', async () => {
    const { runtime } = await setup()
    const taskId = await createSimpleTask(runtime, 'hello')
    const final = await runtime.run(taskId)
    expect(final.state).toBe('completed')
    expect(final.messages).toEqual([
      { role: 'assistant', content: 'Received: hello' },
    ])
    expect(final.result).toEqual({
      replies: ['Received: hello'],
      toolResults: [],
    })
    expect(await eventTypes(runtime, taskId)).toEqual([
      'task.created',
      'task.started',
      'agent.message',
      'task.completed',
    ])
    expect(final.lastSequence).toBe(4)
  })

  it('executes tools through the pipeline and records results', async () => {
    const { runtime } = await setup({
      tools: [echoTool],
      defaultAgent: new MockAgent({
        script: [
          { kind: 'tool', toolId: 'tools.echo', input: { value: 41 } },
          { kind: 'say', content: 'done' },
        ],
      }),
    })
    const taskId = await createSimpleTask(runtime)
    const final = await runtime.run(taskId)
    expect(final.state).toBe('completed')
    expect(final.toolCalls).toHaveLength(1)
    expect(final.toolCalls[0]!.arguments).toEqual({ value: 41 })
    expect(final.toolResults[0]!.output).toEqual({ value: 41 })
    expect(final.toolResults[0]!.error).toBeUndefined()
    expect(await eventTypes(runtime, taskId)).toEqual([
      'task.created',
      'task.started',
      'tool.call',
      'tool.result',
      'agent.message',
      'task.completed',
    ])
  })

  it('turns tool failures into tool result errors, not task failures', async () => {
    const { runtime } = await setup({
      tools: [failingTool],
      defaultAgent: new MockAgent({
        script: [{ kind: 'tool', toolId: 'tools.failing', input: {} }],
      }),
    })
    const taskId = await createSimpleTask(runtime)
    const final = await runtime.run(taskId)
    expect(final.state).toBe('completed')
    expect(final.toolResults[0]!.error).toBe('kaboom')
    expect(final.error).toBeUndefined()
  })

  it('fails the task when the agent throws', async () => {
    const { runtime } = await setup({
      defaultAgent: new MockAgent({
        script: [{ kind: 'fail', message: 'agent exploded' }],
      }),
    })
    const taskId = await createSimpleTask(runtime)
    const final = await runtime.run(taskId)
    expect(final.state).toBe('failed')
    expect(final.error).toBe('agent exploded')
    expect(await eventTypes(runtime, taskId)).toEqual([
      'task.created',
      'task.started',
      'task.failed',
    ])
  })

  it('fails the task when the agent calls an unknown tool', async () => {
    const { runtime } = await setup({
      defaultAgent: new MockAgent({
        script: [{ kind: 'tool', toolId: 'tools.missing', input: {} }],
      }),
    })
    const taskId = await createSimpleTask(runtime)
    const final = await runtime.run(taskId)
    expect(final.state).toBe('failed')
    expect(final.error).toContain("Unknown tool 'tools.missing'")
  })

  it('fails the task when the agent id is unknown', async () => {
    const { runtime } = await setup({ defaultAgent: undefined })
    const spec = await runtime.createTask({
      input: 'hi',
      agentId: 'agent.ghost',
      metadata: {},
    })
    await expect(runtime.run(spec.id)).rejects.toThrow(
      "Unknown agent 'agent.ghost'",
    )
    expect(runtime.kernel.getTaskScope(spec.id)).toBeUndefined()
  })

  it('rejects agent attempts to emit reserved event types', async () => {
    const rogue: Agent = {
      id: 'agent.rogue',
      run: async (context) => {
        await context.emit('task.completed', { state: 'completed' })
        return {}
      },
    }
    const { runtime } = await setup({ defaultAgent: rogue })
    const taskId = await createSimpleTask(runtime)
    const final = await runtime.run(taskId)
    expect(final.state).toBe('failed')
    expect(final.error).toContain('reserved')
  })

  it('rejects invalid operations on task state', async () => {
    const { runtime } = await setup()
    await expect(runtime.run(randomUUID())).rejects.toThrow(TaskRuntimeError)
    const taskId = await createSimpleTask(runtime)
    await runtime.run(taskId)
    await expect(runtime.run(taskId)).rejects.toThrow(
      'only pending tasks can be started',
    )
    await expect(runtime.cancel(taskId)).rejects.toThrow('already finished')
    await expect(runtime.resolveApproval(randomUUID(), true)).rejects.toThrow(
      'No pending approval request',
    )
  })

  it('prevents concurrent runs of the same task', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const blockingTool: Tool = {
      manifest: {
        id: 'tools.block',
        name: 'Block',
        description: 'waits for a gate',
        inputSchema: {},
      },
      execute: () => gate.then(() => 'released'),
    }
    const { runtime } = await setup({
      tools: [blockingTool],
      defaultAgent: new MockAgent({
        script: [{ kind: 'tool', toolId: 'tools.block', input: {} }],
      }),
    })
    const taskId = await createSimpleTask(runtime)
    const running = runtime.run(taskId)
    await expect(runtime.run(taskId)).rejects.toThrow('already running')
    release()
    expect((await running).state).toBe('completed')
  })

  it('cancels a pending task before it starts', async () => {
    const { runtime } = await setup()
    const taskId = await createSimpleTask(runtime)
    const snapshot = await runtime.cancel(taskId, 'not needed')
    expect(snapshot.state).toBe('cancelled')
    expect(snapshot.cancelReason).toBe('not needed')
    await expect(runtime.run(taskId)).rejects.toThrow('only pending tasks')
  })

  it('cancels a running task cooperatively', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const blockingTool: Tool = {
      manifest: {
        id: 'tools.block',
        name: 'Block',
        description: 'waits for a gate',
        inputSchema: {},
      },
      execute: () => gate.then(() => 'released'),
    }
    const { runtime } = await setup({
      tools: [blockingTool],
      defaultAgent: new MockAgent({
        script: [
          { kind: 'say', content: 'step one' },
          { kind: 'tool', toolId: 'tools.block', input: {} },
          { kind: 'say', content: 'never happens' },
        ],
      }),
    })
    const taskId = await createSimpleTask(runtime)
    const running = runtime.run(taskId)
    await vi.waitFor(async () => {
      const snapshot = await runtime.getSnapshot(taskId)
      expect(snapshot.toolCalls).toHaveLength(1)
    })
    await runtime.cancel(taskId, 'user stopped it')
    release()
    const final = await running
    expect(final.state).toBe('cancelled')
    expect(final.cancelReason).toBe('user stopped it')
    expect(final.messages).toEqual([{ role: 'assistant', content: 'step one' }])
    const types = await eventTypes(runtime, taskId)
    expect(types.filter((type) => type === 'task.cancelled')).toEqual([
      'task.cancelled',
    ])
    expect(types).not.toContain('task.completed')
  })

  it('suspends for approval and resumes on approval', async () => {
    const { runtime } = await setup({
      tools: [echoTool],
      policies: [
        {
          id: 'policy.approve-echo',
          checkToolCall: ({ call }) =>
            call.toolId === 'tools.echo'
              ? {
                  effect: 'approval',
                  reason: 'echo is risky',
                  risk: 'medium',
                }
              : { effect: 'allow' },
        },
      ],
      defaultAgent: new MockAgent({
        script: [
          { kind: 'tool', toolId: 'tools.echo', input: { value: 7 } },
          { kind: 'say', content: 'finished' },
        ],
      }),
    })
    const taskId = await createSimpleTask(runtime)
    const running = runtime.run(taskId)
    await vi.waitFor(async () => {
      const snapshot = await runtime.getSnapshot(taskId)
      expect(snapshot.state).toBe('waiting_approval')
    })
    const waiting = await runtime.getSnapshot(taskId)
    const requestId = waiting.pendingApprovalId
    expect(requestId).toBeDefined()
    expect(waiting.approvals[0]!.risk).toBe('medium')
    expect(waiting.approvals[0]!.reason).toBe('echo is risky')

    const decision = await runtime.resolveApproval(requestId!, true)
    expect(decision.approved).toBe(true)
    const final = await running
    expect(final.state).toBe('completed')
    expect(final.pendingApprovalId).toBeUndefined()
    expect(final.toolResults[0]!.output).toEqual({ value: 7 })
    expect(final.decisions[0]!.approved).toBe(true)
    expect(await eventTypes(runtime, taskId)).toEqual([
      'task.created',
      'task.started',
      'tool.call',
      'approval.requested',
      'task.suspended',
      'approval.decided',
      'task.resumed',
      'tool.result',
      'agent.message',
      'task.completed',
    ])
  })

  it('resumes with a denied tool result when approval is rejected', async () => {
    const { runtime } = await setup({
      tools: [echoTool],
      policies: [
        {
          id: 'policy.approve-echo',
          checkToolCall: () => ({
            effect: 'approval',
            reason: 'echo is risky',
            risk: 'high',
          }),
        },
      ],
      defaultAgent: new MockAgent({
        script: [{ kind: 'tool', toolId: 'tools.echo', input: {} }],
      }),
    })
    const taskId = await createSimpleTask(runtime)
    const running = runtime.run(taskId)
    await vi.waitFor(async () => {
      expect((await runtime.getSnapshot(taskId)).state).toBe('waiting_approval')
    })
    const waiting = await runtime.getSnapshot(taskId)
    await runtime.resolveApproval(waiting.pendingApprovalId!, false, {
      reason: 'not today',
    })
    const final = await running
    expect(final.state).toBe('completed')
    expect(final.toolResults[0]!.error).toContain('not approved')
    expect(final.decisions[0]!.reason).toBe('not today')
    await expect(
      runtime.resolveApproval(waiting.pendingApprovalId!, true),
    ).rejects.toThrow('No pending approval request')
  })

  it('treats expired approvals as denied', async () => {
    const { runtime } = await setup({
      tools: [echoTool],
      policies: [
        {
          id: 'policy.expired',
          checkToolCall: () => ({
            effect: 'approval',
            reason: 'rare tool',
            risk: 'low',
            expiresAt: new Date('2020-01-01T00:00:00Z').toISOString(),
          }),
        },
      ],
      defaultAgent: new MockAgent({
        script: [{ kind: 'tool', toolId: 'tools.echo', input: {} }],
      }),
    })
    const taskId = await createSimpleTask(runtime)
    const running = runtime.run(taskId)
    await vi.waitFor(async () => {
      expect((await runtime.getSnapshot(taskId)).state).toBe('waiting_approval')
    })
    const waiting = await runtime.getSnapshot(taskId)
    const decision = await runtime.resolveApproval(
      waiting.pendingApprovalId!,
      true,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reason).toBe('approval request expired')
    const final = await running
    expect(final.state).toBe('completed')
    expect(final.toolResults[0]!.error).toContain('not approved')
  })

  it('cancels a task waiting for approval', async () => {
    const { runtime } = await setup({
      tools: [echoTool],
      policies: [
        {
          id: 'policy.approve-echo',
          checkToolCall: () => ({
            effect: 'approval',
            reason: 'echo is risky',
            risk: 'low',
          }),
        },
      ],
      defaultAgent: new MockAgent({
        script: [{ kind: 'tool', toolId: 'tools.echo', input: {} }],
      }),
    })
    const taskId = await createSimpleTask(runtime)
    const running = runtime.run(taskId)
    await vi.waitFor(async () => {
      expect((await runtime.getSnapshot(taskId)).state).toBe('waiting_approval')
    })
    const final = await runtime.cancel(taskId, 'gave up')
    expect(final.state).toBe('cancelled')
    expect(await running).toEqual(final)
  })

  it('resolves the event store through the kernel service catalog', async () => {
    const kernel = createKernel()
    kernels.push(kernel)
    await kernel.start()
    const store = new MemoryEventStore()
    kernel.registerService(eventStoreService, store)
    const runtime = new TaskRuntime(kernel)
    runtime.registerAgent(new MockAgent())
    const spec = await runtime.createTask({
      input: 'via service',
      agentId: 'agent.mock',
      metadata: {},
    })
    const final = await runtime.run(spec.id)
    expect(final.state).toBe('completed')
    expect(await store.getLatestSequence(spec.id)).toBe(4)
  })

  it('dispatches task/event-recorded for every appended event', async () => {
    const { kernel, runtime } = await setup({
      tools: [echoTool],
      defaultAgent: new MockAgent({
        script: [{ kind: 'tool', toolId: 'tools.echo', input: { v: 1 } }],
      }),
    })
    const recorded: string[] = []
    kernel.events.on(taskEventRecordedEvent, ({ event }) => {
      recorded.push(`${event.taskId}:${event.sequence}:${event.type}`)
    })
    const taskId = await createSimpleTask(runtime)
    await runtime.run(taskId)
    expect(recorded).toHaveLength(5)
    expect(recorded[0]).toContain('task.created')
    expect(recorded.at(-1)).toContain('task.completed')
  })

  it('disposes the task scope when the run finishes', async () => {
    const { kernel, runtime } = await setup()
    const taskId = await createSimpleTask(runtime)
    await runtime.run(taskId)
    expect(kernel.getTaskScope(taskId)).toBeUndefined()
  })

  it('rebuilds snapshots from the event store with a fresh runtime', async () => {
    const { store, runtime } = await setup({
      tools: [echoTool],
      defaultAgent: new MockAgent({
        script: [
          { kind: 'say', content: 'one' },
          { kind: 'tool', toolId: 'tools.echo', input: { n: 1 } },
        ],
      }),
    })
    const taskId = await createSimpleTask(runtime)
    const live = await runtime.run(taskId)

    const kernel = createKernel()
    kernels.push(kernel)
    await kernel.start()
    const replayed = new TaskRuntime(kernel, {
      eventStore: store,
      defaultAgent: new MockAgent(),
    })
    await expect(replayed.getSnapshot(taskId)).resolves.toStrictEqual(live)
    await expect(replayed.run(taskId)).rejects.toThrow('only pending tasks')
    const events: ToolResult[] = []
    for await (const event of replayed.readEvents(taskId, 3)) {
      if (event.type === 'tool.result') {
        events.push((event.payload as { result: ToolResult }).result)
      }
    }
    expect(events).toHaveLength(1)
  })
})
