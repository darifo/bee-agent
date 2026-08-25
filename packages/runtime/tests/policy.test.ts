import { describe, expect, it } from 'vitest'
import { EventBus } from '@bee-agent/kernel'
import type { ToolCall } from '@bee-agent/contracts'
import {
  PolicyEngine,
  createToolAllowlistPolicy,
  createToolApprovalPolicy,
  failedToolResult,
  toolExecuteEvent,
  toolPolicyMiddleware,
} from '../src/index.ts'
import type { ToolExecutionContext, ToolPolicy } from '../src/index.ts'

const taskId = '4e5d6c58-6c66-4c99-bd51-6b2b6c0b7cc1'

function callOf(toolId: string): ToolCall {
  return {
    id: crypto.randomUUID(),
    taskId,
    toolId,
    arguments: {},
  }
}

function contextFor(
  toolId: string,
  hooks: ToolExecutionContext['hooks'],
): ToolExecutionContext {
  return {
    call: callOf(toolId),
    tool: {
      manifest: {
        id: toolId,
        name: toolId,
        description: '',
        inputSchema: {},
      },
      execute: () => 'executed',
    },
    hooks,
  }
}

describe('policy engine', () => {
  it('allows when every policy allows', () => {
    const engine = new PolicyEngine([
      { id: 'p1', checkToolCall: () => ({ effect: 'allow' }) },
      { id: 'p2', checkToolCall: () => ({ effect: 'allow' }) },
    ])
    expect(
      engine.evaluate({
        taskId,
        call: callOf('t'),
        manifest: { id: 't', name: 't', description: '', inputSchema: {} },
      }),
    ).toEqual({
      effect: 'allow',
    })
  })

  it('returns the first decisive decision in registration order', () => {
    const engine = new PolicyEngine([
      {
        id: 'p.deny-danger',
        checkToolCall: ({ call }) =>
          call.toolId === 'tools.danger'
            ? { effect: 'deny', reason: 'too dangerous' }
            : { effect: 'allow' },
      },
      {
        id: 'p.approve-rest',
        checkToolCall: () => ({
          effect: 'approval',
          reason: 'needs a human',
          risk: 'high',
        }),
      },
    ])
    const manifest = (id: string) => ({
      id,
      name: id,
      description: '',
      inputSchema: {},
    })
    // Deny wins because its policy is registered first.
    expect(
      engine.evaluate({
        taskId,
        call: callOf('tools.danger'),
        manifest: manifest('tools.danger'),
      }),
    ).toEqual({ effect: 'deny', reason: 'too dangerous' })
    // An earlier allow does not short-circuit a later approval requirement.
    expect(
      engine.evaluate({
        taskId,
        call: callOf('tools.other'),
        manifest: manifest('tools.other'),
      }),
    ).toEqual({ effect: 'approval', reason: 'needs a human', risk: 'high' })
  })

  it('denies tools outside the allowlist', () => {
    const policy = createToolAllowlistPolicy({ allowed: ['tools.safe'] })
    expect(
      policy.checkToolCall({
        taskId,
        call: callOf('tools.safe'),
        manifest: {
          id: 'tools.safe',
          name: '',
          description: '',
          inputSchema: {},
        },
      }),
    ).toEqual({ effect: 'allow' })
    const decision = policy.checkToolCall({
      taskId,
      call: callOf('tools.unsafe'),
      manifest: {
        id: 'tools.unsafe',
        name: '',
        description: '',
        inputSchema: {},
      },
    })
    expect(decision.effect).toBe('deny')
  })

  it('requires approval for listed tools with their risk', () => {
    const policy = createToolApprovalPolicy({
      approvals: { 'tools.pay': 'high' },
    })
    const manifest = (id: string) => ({
      id,
      name: '',
      description: '',
      inputSchema: {},
    })
    expect(
      policy.checkToolCall({
        taskId,
        call: callOf('tools.read'),
        manifest: manifest('tools.read'),
      }),
    ).toEqual({ effect: 'allow' })
    expect(
      policy.checkToolCall({
        taskId,
        call: callOf('tools.pay'),
        manifest: manifest('tools.pay'),
      }),
    ).toEqual({
      effect: 'approval',
      reason: "tool 'tools.pay' is classified as risk 'high'",
      risk: 'high',
    })
  })
})

describe('tool policy middleware', () => {
  it('runs the terminal when allowed', async () => {
    const bus = new EventBus()
    bus.use(toolExecuteEvent, toolPolicyMiddleware(new PolicyEngine([])))
    const result = await bus.waterfall(
      toolExecuteEvent,
      contextFor('tools.safe', {
        requestApproval: () => {
          throw new Error('should not request approval')
        },
      }),
      async (payload) => ({ callId: payload.call.id, output: 'ok' }),
    )
    expect(result).toEqual({ callId: result.callId, output: 'ok' })
  })

  it('short-circuits denials without running the tool', async () => {
    const bus = new EventBus()
    bus.use(
      toolExecuteEvent,
      toolPolicyMiddleware(
        new PolicyEngine([createToolAllowlistPolicy({ allowed: [] })]),
      ),
    )
    let terminalRan = false
    const result = await bus.waterfall(
      toolExecuteEvent,
      contextFor('tools.safe', {
        requestApproval: () => Promise.resolve(true),
      }),
      async () => {
        terminalRan = true
        throw new Error('unreachable')
      },
    )
    expect(terminalRan).toBe(false)
    expect(result.error).toContain('denied by policy')
    expect(result.output).toBeUndefined()
  })

  it('suspends for approval and honors the decision', async () => {
    const bus = new EventBus()
    bus.use(
      toolExecuteEvent,
      toolPolicyMiddleware(
        new PolicyEngine([
          createToolApprovalPolicy({ approvals: { 'tools.pay': 'high' } }),
        ]),
      ),
    )
    const requested: string[] = []
    const result = await bus.waterfall(
      toolExecuteEvent,
      contextFor('tools.pay', {
        requestApproval: (input) => {
          requested.push(input.call.toolId)
          expect(input.risk).toBe('high')
          expect(input.reason).toContain("risk 'high'")
          return Promise.resolve(false)
        },
      }),
      async () => {
        throw new Error('terminal must not run when denied')
      },
    )
    expect(requested).toEqual(['tools.pay'])
    expect(result.error).toContain('not approved')

    const approved = await bus.waterfall(
      toolExecuteEvent,
      contextFor('tools.pay', {
        requestApproval: () => Promise.resolve(true),
      }),
      async (payload) => ({ callId: payload.call.id, output: 'paid' }),
    )
    expect(approved.output).toBe('paid')
    expect(approved.error).toBeUndefined()
  })

  it('forwards expiry from the policy decision', async () => {
    const expiresAt = new Date('2020-01-01T00:00:00Z').toISOString()
    const policy: ToolPolicy = {
      id: 'policy.expires',
      checkToolCall: () => ({
        effect: 'approval',
        reason: 'rare tool',
        risk: 'medium',
        expiresAt,
      }),
    }
    const bus = new EventBus()
    bus.use(toolExecuteEvent, toolPolicyMiddleware(new PolicyEngine([policy])))
    const seen: (string | undefined)[] = []
    await bus.waterfall(
      toolExecuteEvent,
      contextFor('tools.rare', {
        requestApproval: (input) => {
          seen.push(input.expiresAt)
          return Promise.resolve(true)
        },
      }),
      async (payload) => ({ callId: payload.call.id, output: null }),
    )
    expect(seen).toEqual([expiresAt])
  })

  it('failedToolResult carries the error', () => {
    const result = failedToolResult('call-1', 'boom')
    expect(result).toEqual({
      callId: 'call-1',
      output: undefined,
      error: 'boom',
    })
  })
})
