import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { BeeAgentClient } from '@bee-agent/client'
import type { BeeAgentClientError } from '@bee-agent/client'
import type { AgentEvent } from '@bee-agent/contracts'
import { MockAgent, createToolApprovalPolicy } from '@bee-agent/runtime'
import type { MockAgentOptions, Tool } from '@bee-agent/runtime'
import { buildServer } from '../src/index.js'
import type { BeeServer } from '../src/index.js'

let server: BeeServer
let api: BeeAgentClient
let baseUrl: string

let releaseGate: () => void = () => {}
const gate = new Promise<void>((resolve) => {
  releaseGate = resolve
})

const gateTool: Tool = {
  manifest: {
    id: 'tools.gate',
    name: 'Gate',
    description: 'blocks until the test releases it',
    inputSchema: {},
  },
  execute: () => gate.then(() => 'released'),
}

beforeAll(async () => {
  server = await buildServer({
    sqliteFilename: ':memory:',
    logger: false,
    policies: [
      createToolApprovalPolicy({ approvals: { 'tools.calculator': 'medium' } }),
    ],
  })
  server.runtime.tools.register(gateTool)
  await server.app.listen({ host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`
  api = new BeeAgentClient({ baseUrl })
})

afterAll(async () => {
  server.app.server.closeAllConnections()
  await server.app.close()
})

let agentCounter = 0

/** Registers a fresh mock agent so concurrent scripts never collide. */
function registerAgent(
  script: NonNullable<MockAgentOptions['script']>,
): string {
  agentCounter += 1
  const id = `agent.test-${agentCounter}`
  server.runtime.registerAgent(new MockAgent({ id, script }))
  return id
}

async function createTask(
  agentId: string,
  input = 'default input',
): Promise<string> {
  const response = await api.createTask({ input, agentId, metadata: {} })
  return response.task.id
}

async function streamAll(taskId: string, after = 0): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of api.streamEvents(taskId, { after })) {
    events.push(event)
  }
  return events
}

describe('bee agent server', () => {
  it('serves health checks', async () => {
    const response = await fetch(new URL('/health', baseUrl))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  })

  it('runs a task through approval and streams the full event history over SSE', async () => {
    const agentId = registerAgent([
      {
        kind: 'tool',
        toolId: 'tools.calculator',
        input: { expression: '1 + 2 * 3' },
      },
      { kind: 'say', content: 'done' },
    ])
    const taskId = await createTask(agentId)
    expect((await api.getTask(taskId)).state).toBe('pending')

    const running = await api.runTask(taskId)
    expect(['running', 'waiting_approval']).toContain(running.state)

    await vi.waitFor(async () => {
      expect((await api.getTask(taskId)).state).toBe('waiting_approval')
    })
    const approvals = await api.listPendingApprovals(taskId)
    expect(approvals).toHaveLength(1)
    expect(approvals[0]!.toolCall.toolId).toBe('tools.calculator')

    const decision = await api.resolveApproval(
      approvals[0]!.id,
      true,
      'go ahead',
    )
    expect(decision.approved).toBe(true)

    const events = await streamAll(taskId)
    expect(events.map((event) => event.type)).toEqual([
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
    const final = await api.getTask(taskId)
    expect(final.state).toBe('completed')
    expect(final.toolResults[0]!.output).toEqual({ value: 7 })
    expect(final.messages).toEqual([{ role: 'assistant', content: 'done' }])
  })

  it('resumes SSE from Last-Event-ID', async () => {
    const agentId = registerAgent([])
    const taskId = await createTask(agentId, 'echo me')
    await api.runTask(taskId)
    const all = await streamAll(taskId)
    expect(all.length).toBeGreaterThanOrEqual(4)
    const resumed = await streamAll(taskId, 2)
    expect(resumed[0]!.sequence).toBe(3)
    expect(resumed.map((event) => event.sequence)).toEqual(
      all.filter((event) => event.sequence > 2).map((event) => event.sequence),
    )
  })

  it('denies approvals and records the tool error', async () => {
    const agentId = registerAgent([
      { kind: 'tool', toolId: 'tools.calculator', input: { expression: '2' } },
    ])
    const taskId = await createTask(agentId, 'denied flow')
    await api.runTask(taskId)
    await vi.waitFor(async () => {
      expect((await api.getTask(taskId)).state).toBe('waiting_approval')
    })
    const [approval] = await api.listPendingApprovals(taskId)
    await api.resolveApproval(approval!.id, false, 'not today')
    const final = await api.getTask(taskId)
    expect(final.state).toBe('completed')
    expect(final.toolResults[0]!.error).toContain('not approved')
  })

  it('cancels a running task', async () => {
    const agentId = registerAgent([
      { kind: 'say', content: 'entering gate' },
      { kind: 'tool', toolId: 'tools.gate', input: {} },
      { kind: 'say', content: 'never' },
    ])
    const taskId = await createTask(agentId, 'gated flow')
    await api.runTask(taskId)
    await vi.waitFor(async () => {
      expect((await api.getTask(taskId)).toolCalls).toHaveLength(1)
    })
    const cancelled = await api.cancelTask(taskId, 'user stopped it')
    expect(cancelled.state).toBe('cancelled')
    expect(cancelled.cancelReason).toBe('user stopped it')
    releaseGate()
    const settled = await api.getTask(taskId)
    expect(settled.state).toBe('cancelled')
    expect(settled.messages).toEqual([
      { role: 'assistant', content: 'entering gate' },
    ])
  })

  it('lists events with an after cursor', async () => {
    const agentId = registerAgent([])
    const taskId = await createTask(agentId, 'list events')
    await api.runTask(taskId)
    const tail = await api.listEvents(taskId, 2)
    expect(tail.length).toBeGreaterThanOrEqual(1)
    expect(tail[0]!.sequence).toBe(3)
  })

  it('maps errors to statuses and envelopes', async () => {
    const missing = crypto.randomUUID()
    const error = (await api
      .getTask(missing)
      .catch((reason: unknown) => reason)) as BeeAgentClientError
    expect(error.status).toBe(404)
    expect(error.code).toBe('task-not-found')

    const agentId = registerAgent([])
    const taskId = await createTask(agentId, 'finish once')
    await api.runTask(taskId)
    await vi.waitFor(async () => {
      expect((await api.getTask(taskId)).state).toBe('completed')
    })
    const rerun = (await api
      .runTask(taskId)
      .catch((reason: unknown) => reason)) as BeeAgentClientError
    expect(rerun.status).toBe(409)
    expect(rerun.code).toBe('invalid-task-state')

    const invalid = (await api
      .createTask({ input: '', agentId: 'x', metadata: {} })
      .catch((reason: unknown) => reason)) as BeeAgentClientError
    expect(invalid.status).toBe(400)
    expect(invalid.code).toBe('validation-failed')

    const unknownApproval = (await api
      .resolveApproval(crypto.randomUUID(), true)
      .catch((reason: unknown) => reason)) as BeeAgentClientError
    expect(unknownApproval.status).toBe(404)
    expect(unknownApproval.code).toBe('approval-not-found')
  })
})
