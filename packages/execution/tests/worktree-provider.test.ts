import { describe, expect, it } from 'vitest'
import { ChronicleSchemaRegistry } from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import {
  ExecutionWorld,
  StaticAuthorizationPolicy,
  registerExecutionChronicleEvents,
  type ActionRequest,
  type SandboxProvider,
} from '../src/execution-world.ts'
import { ExecutionWorktreeProvider } from '../src/worktree-provider.ts'

describe('ExecutionWorktreeProvider', () => {
  it('routes create and remove through declared ExecutionWorld actions', async () => {
    const requests: ActionRequest[] = []
    const sandbox: SandboxProvider = {
      async execute(request) {
        requests.push(request)
        return { output: {}, content: '', verification: request.verification }
      },
      async snapshot(request) {
        return { ref: request.id, capturedAt: new Date().toISOString() }
      },
      async diff() {
        return {}
      },
      async capabilities() {
        return {
          provider: 'fake-process',
          filesystemIsolation: true,
          networkIsolation: true,
          processIsolation: true,
        }
      },
    }
    const registry = new ChronicleSchemaRegistry()
    registerExecutionChronicleEvents(registry)
    const world = new ExecutionWorld({
      store: new MemoryChronicleStore(registry),
      policy: new StaticAuthorizationPolicy([
        {
          capability: 'workspace:worktree:create',
          decision: 'allow',
          reason: 'test',
        },
        {
          capability: 'workspace:worktree:remove',
          decision: 'allow',
          reason: 'test',
        },
      ]),
      sandbox,
    })
    const provider = new ExecutionWorktreeProvider({
      world,
      gitExecutable: '/usr/bin/git',
      repositoryRoot: '/workspace/repo',
      worktreeRoot: '/workspace/worktrees',
    })
    const created = await provider.create({
      name: 'task-123',
      baseRef: 'main',
      threadId: 'thread',
      turnId: 'turn',
    })
    expect(created.outcome.kind).toBe('result')
    await provider.remove(created.handle, {
      threadId: 'thread',
      turnId: 'turn',
    })
    expect(requests.map((request) => request.capability)).toEqual([
      'workspace:worktree:create',
      'workspace:worktree:remove',
    ])
    expect(requests[0]?.requirements.commands[0]).toEqual([
      '/usr/bin/git',
      '-C',
      '/workspace/repo',
      'worktree',
      'add',
      '--detach',
      '/workspace/worktrees/task-123',
      'main',
    ])
  })

  it('rejects path-shaped names before constructing an action', async () => {
    const provider = new ExecutionWorktreeProvider({
      world: {} as ExecutionWorld,
      gitExecutable: '/usr/bin/git',
      repositoryRoot: '/workspace/repo',
      worktreeRoot: '/workspace/worktrees',
    })
    await expect(
      provider.create({
        name: '../escape',
        threadId: 'thread',
        turnId: 'turn',
      }),
    ).rejects.toThrow('safe')
  })
})
