import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChronicleSchemaRegistry } from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import {
  ExecutionWorld,
  IdempotencyKeyCollisionError,
  IntersectionAuthorizationPolicy,
  StaticAuthorizationPolicy,
  canonicalizeActionRequest,
  executionStreamId,
  registerExecutionChronicleEvents,
  type ActionRequest,
  type ActionResult,
  type SandboxProvider,
  type SecretBroker,
} from '../src/execution-world.ts'

function store(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerExecutionChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

function request(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    id: crypto.randomUUID(),
    idempotencyKey: 'turn-1/call-1',
    capability: 'tool:calculator',
    subject: { type: 'agent', id: 'bee' },
    input: { a: 1, b: 2 },
    requirements: {
      readPaths: [],
      writePaths: [],
      networkTargets: [],
      commands: [],
      secretEnv: {},
    },
    expectedEffects: ['Return a calculated value'],
    verification: ['Result equals 3'],
    scope: { threadId: 'thread-1', turnId: 'turn-1' },
    ...overrides,
  }
}

class FakeSandbox implements SandboxProvider {
  calls = 0
  fail = false
  result: ActionResult = {
    output: 3,
    content: '3',
    verification: ['Result equals 3'],
  }

  async execute(): Promise<ActionResult> {
    this.calls += 1
    if (this.fail) throw new Error('executor crashed')
    return this.result
  }

  async snapshot() {
    return {
      ref: `snapshot:${this.calls}`,
      capturedAt: new Date().toISOString(),
    }
  }

  async diff(before: { ref: string }, after: { ref: string }) {
    return { before: before.ref, after: after.ref }
  }

  async capabilities() {
    return {
      provider: 'fake',
      filesystemIsolation: true,
      networkIsolation: true,
      processIsolation: true,
    }
  }
}

async function eventTypes(
  chronicle: MemoryChronicleStore,
  idempotencyKey: string,
): Promise<string[]> {
  const result: string[] = []
  for await (const event of chronicle.readStream(
    executionStreamId(idempotencyKey),
  )) {
    result.push(event.eventType)
  }
  return result
}

describe('ExecutionWorld', () => {
  it('canonicalizes declared paths and executables before authorization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bee-action-'))
    const target = join(directory, 'target')
    const link = join(directory, 'link')
    await mkdir(target)
    await symlink(target, link)
    try {
      const resolved = await canonicalizeActionRequest(
        request({
          requirements: {
            readPaths: [link],
            writePaths: [join(link, 'new-file')],
            networkTargets: [],
            commands: [['/bin/echo', 'hello']],
            secretEnv: {},
          },
        }),
      )
      expect(resolved.requirements.readPaths).toEqual([await realpath(target)])
      expect(resolved.requirements.writePaths).toEqual([
        join(await realpath(target), 'new-file'),
      ])
      expect(resolved.requirements.commands[0]?.[0]).toBe(
        await realpath('/bin/echo'),
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects relative resource paths and executables', async () => {
    await expect(
      canonicalizeActionRequest(
        request({
          requirements: {
            readPaths: ['relative'],
            writePaths: [],
            networkTargets: [],
            commands: [['echo', 'hello']],
            secretEnv: {},
          },
        }),
      ),
    ).rejects.toThrow()
  })

  it('allows stdin only for exactly one declared command', async () => {
    await expect(
      canonicalizeActionRequest(
        request({
          requirements: {
            readPaths: [],
            writePaths: [],
            networkTargets: [],
            commands: [],
            commandStdin: 'orphan input',
            secretEnv: {},
          },
        }),
      ),
    ).rejects.toThrow('exactly one command')
  })

  it('requires staged stdio to end on an explicit response condition', async () => {
    await expect(
      canonicalizeActionRequest(
        request({
          requirements: {
            readPaths: [],
            writePaths: [],
            networkTargets: [],
            commands: [['/bin/cat']],
            commandStdio: {
              kind: 'json-lines',
              steps: [{ input: '{}\n' }],
            },
            secretEnv: {},
          },
        }),
      ),
    ).rejects.toThrow('completion condition')
  })

  it('authorizes, records, executes once, and replays the durable result', async () => {
    const chronicle = store()
    const sandbox = new FakeSandbox()
    const world = new ExecutionWorld({
      store: chronicle,
      policy: new StaticAuthorizationPolicy([
        {
          capability: 'tool:calculator',
          decision: 'allow',
          reason: 'local tool',
        },
      ]),
      sandbox,
    })
    const action = request()
    const [first, second] = await Promise.all([
      world.execute(action),
      world.execute(action),
    ])

    expect(first).toMatchObject({ kind: 'result', replayed: false })
    expect(second).toMatchObject({ kind: 'result', replayed: true })
    expect(sandbox.calls).toBe(1)
    expect(await eventTypes(chronicle, action.idempotencyKey)).toEqual([
      'execution.requested',
      'execution.permission_snapshot',
      'execution.authorized',
      'execution.started',
      'execution.completed',
    ])
  })

  it('materializes a deny-first monotonic permission intersection', async () => {
    const chronicle = store()
    const sandbox = new FakeSandbox()
    const policy = new IntersectionAuthorizationPolicy([
      {
        id: 'hard-safety',
        rules: [{ capability: '*', decision: 'allow', reason: 'safe' }],
      },
      {
        id: 'plugin-declaration',
        rules: [
          {
            capability: 'tool:calculator',
            decision: 'allow',
            reason: 'declared',
          },
        ],
      },
      { id: 'task-scope', rules: [] },
    ])
    const action = request()
    const outcome = await new ExecutionWorld({
      store: chronicle,
      policy,
      sandbox,
    }).execute(action)
    expect(outcome).toMatchObject({ kind: 'denied' })
    const payloads: unknown[] = []
    for await (const item of chronicle.readStream(
      executionStreamId(action.idempotencyKey),
    )) {
      if (item.eventType === 'execution.permission_snapshot')
        payloads.push(item.payload)
    }
    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toMatchObject({
      snapshot: {
        decision: 'deny',
        sandbox: { provider: 'fake' },
        layers: [
          { id: 'hard-safety', decision: 'allow' },
          { id: 'plugin-declaration', decision: 'allow' },
          { id: 'task-scope', decision: 'deny' },
        ],
      },
    })
  })

  it('lets an exact hard deny override a wildcard grant', () => {
    const policy = new IntersectionAuthorizationPolicy([
      {
        id: 'hard-safety',
        rules: [
          {
            capability: 'tool:calculator',
            decision: 'deny',
            reason: 'immutable deny',
          },
          { capability: '*', decision: 'allow', reason: 'otherwise safe' },
        ],
      },
      {
        id: 'user-grant',
        rules: [{ capability: '*', decision: 'allow', reason: 'granted' }],
      },
    ])
    expect(policy.authorize(request())).toEqual({
      decision: 'deny',
      reason: 'immutable deny',
    })
  })

  it('persists concrete approval details and executes only after approval', async () => {
    const chronicle = store()
    const sandbox = new FakeSandbox()
    const world = new ExecutionWorld({
      store: chronicle,
      policy: new StaticAuthorizationPolicy([
        {
          capability: 'tool:deploy',
          decision: 'ask',
          reason: 'production change',
        },
      ]),
      sandbox,
    })
    const action = request({
      capability: 'tool:deploy',
      input: { environment: 'production' },
      expectedEffects: ['Deploy release to production'],
    })
    const pending = await world.execute(action)
    expect(pending).toMatchObject({ kind: 'approval-required' })
    if (pending.kind === 'approval-required') {
      expect(pending.detail).toContain('production')
      expect(pending.detail).toContain('tool:deploy')
    }
    expect(sandbox.calls).toBe(0)

    const completed = await world.execute(action, { approval: 'approved' })
    expect(completed.kind).toBe('result')
    expect(sandbox.calls).toBe(1)
  })

  it('denies undeclared capabilities and unsupported sandbox requirements', async () => {
    const chronicle = store()
    const sandbox = new FakeSandbox()
    const world = new ExecutionWorld({
      store: chronicle,
      policy: new StaticAuthorizationPolicy([]),
      sandbox,
    })
    expect((await world.execute(request())).kind).toBe('denied')
    expect(sandbox.calls).toBe(0)

    const constrained = new ExecutionWorld({
      store: chronicle,
      policy: new StaticAuthorizationPolicy([
        { capability: 'tool:command', decision: 'allow', reason: 'declared' },
      ]),
      sandbox: {
        ...sandbox,
        execute: sandbox.execute.bind(sandbox),
        snapshot: sandbox.snapshot.bind(sandbox),
        diff: sandbox.diff.bind(sandbox),
        async capabilities() {
          return {
            provider: 'logical-only',
            filesystemIsolation: false,
            networkIsolation: false,
            processIsolation: false,
          }
        },
      },
    })
    const denied = await constrained.execute(
      request({
        id: crypto.randomUUID(),
        idempotencyKey: 'turn-1/call-command',
        capability: 'tool:command',
        requirements: {
          readPaths: [],
          writePaths: [],
          networkTargets: [],
          commands: [['/usr/bin/git', 'status']],
          secretEnv: {},
        },
      }),
    )
    expect(denied).toMatchObject({ kind: 'denied' })
  })

  it('detects idempotency collisions and refuses ambiguous crash replay', async () => {
    const chronicle = store()
    const sandbox = new FakeSandbox()
    sandbox.fail = true
    const world = new ExecutionWorld({
      store: chronicle,
      policy: new StaticAuthorizationPolicy([
        { capability: 'tool:calculator', decision: 'allow', reason: 'test' },
      ]),
      sandbox,
    })
    const action = request()
    expect((await world.execute(action)).kind).toBe('result')
    expect((await world.execute(action)).kind).toBe('reconciliation-required')
    await expect(
      world.execute({ ...action, input: { a: 9, b: 9 } }),
    ).rejects.toBeInstanceOf(IdempotencyKeyCollisionError)
    expect(sandbox.calls).toBe(1)
  })

  it('never persists materialized secret values in results', async () => {
    const chronicle = store()
    const sandbox = new FakeSandbox()
    sandbox.result = {
      output: { token: 'super-secret' },
      content: 'token=super-secret',
      worldDiff: { value: 'super-secret' },
      verification: [],
    }
    const broker: SecretBroker = {
      async materialize() {
        return new Map([['api-key', 'super-secret']])
      },
      redact(value) {
        return value.replaceAll('super-secret', '[REDACTED]')
      },
    }
    const world = new ExecutionWorld({
      store: chronicle,
      policy: new StaticAuthorizationPolicy([
        { capability: 'tool:remote', decision: 'allow', reason: 'test' },
      ]),
      sandbox,
      secrets: broker,
    })
    const action = request({
      capability: 'tool:remote',
      requirements: {
        readPaths: [],
        writePaths: [],
        networkTargets: [],
        commands: [],
        secretEnv: { API_KEY: 'api-key' },
      },
    })
    const outcome = await world.execute(action)
    expect(JSON.stringify(outcome)).not.toContain('super-secret')
    const stored: unknown[] = []
    for await (const event of chronicle.readStream(
      executionStreamId(action.idempotencyKey),
    )) {
      stored.push(event.payload)
    }
    expect(JSON.stringify(stored)).not.toContain('super-secret')
  })
})
