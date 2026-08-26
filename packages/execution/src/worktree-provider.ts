import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative } from 'node:path'
import type {
  ActionRequest,
  ExecutionOptions,
  ExecutionOutcome,
  ExecutionWorld,
} from './execution-world.ts'

export interface WorktreeRequestScope {
  readonly threadId: string
  readonly turnId: string
  readonly structureVersion?: string | undefined
}

export interface WorktreeHandle {
  readonly id: string
  readonly path: string
  readonly baseRef: string
}

function contained(root: string, path: string): boolean {
  const child = relative(root, path)
  return child !== '' && !child.startsWith('..') && !isAbsolute(child)
}

/** Git worktrees whose lifecycle is routed through ExecutionWorld. */
export class ExecutionWorktreeProvider {
  readonly #world: ExecutionWorld
  readonly #gitExecutable: string
  readonly #repositoryRoot: string
  readonly #worktreeRoot: string

  constructor(options: {
    readonly world: ExecutionWorld
    readonly gitExecutable: string
    readonly repositoryRoot: string
    readonly worktreeRoot: string
  }) {
    if (!isAbsolute(options.gitExecutable))
      throw new Error('Git executable must be absolute')
    if (
      !isAbsolute(options.repositoryRoot) ||
      !isAbsolute(options.worktreeRoot)
    )
      throw new Error('Worktree roots must be absolute')
    this.#world = options.world
    this.#gitExecutable = options.gitExecutable
    this.#repositoryRoot = options.repositoryRoot
    this.#worktreeRoot = options.worktreeRoot
  }

  async create(
    input: WorktreeRequestScope & {
      readonly name: string
      readonly baseRef?: string | undefined
    },
    options: ExecutionOptions = {},
  ): Promise<{
    readonly handle: WorktreeHandle
    readonly outcome: ExecutionOutcome
  }> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(input.name))
      throw new Error('Worktree name must be a safe 1-64 character slug')
    const path = join(this.#worktreeRoot, input.name)
    if (!contained(this.#worktreeRoot, path))
      throw new Error('Worktree path escapes the configured root')
    const baseRef = input.baseRef ?? 'HEAD'
    const id = randomUUID()
    const request = this.#request({
      id,
      key: `worktree:create:${input.threadId}:${input.turnId}:${input.name}`,
      capability: 'workspace:worktree:create',
      scope: input,
      command: [
        this.#gitExecutable,
        '-C',
        this.#repositoryRoot,
        'worktree',
        'add',
        '--detach',
        path,
        baseRef,
      ],
      effects: [`Create isolated Git worktree at ${path}`],
    })
    return {
      handle: { id, path, baseRef },
      outcome: await this.#world.execute(request, options),
    }
  }

  remove(
    handle: WorktreeHandle,
    scope: WorktreeRequestScope,
    options: ExecutionOptions = {},
  ): Promise<ExecutionOutcome> {
    if (!contained(this.#worktreeRoot, handle.path))
      throw new Error('Worktree path escapes the configured root')
    return this.#world.execute(
      this.#request({
        id: randomUUID(),
        key: `worktree:remove:${scope.threadId}:${scope.turnId}:${handle.id}`,
        capability: 'workspace:worktree:remove',
        scope,
        command: [
          this.#gitExecutable,
          '-C',
          this.#repositoryRoot,
          'worktree',
          'remove',
          '--force',
          handle.path,
        ],
        effects: [`Remove isolated Git worktree at ${handle.path}`],
      }),
      options,
    )
  }

  #request(input: {
    readonly id: string
    readonly key: string
    readonly capability: string
    readonly scope: WorktreeRequestScope
    readonly command: readonly string[]
    readonly effects: readonly string[]
  }): ActionRequest {
    return {
      id: input.id,
      idempotencyKey: input.key,
      capability: input.capability,
      subject: { type: 'system', id: 'worktree-provider' },
      input: { command: input.command },
      requirements: {
        readPaths: [this.#repositoryRoot],
        writePaths: [this.#repositoryRoot, this.#worktreeRoot],
        networkTargets: [],
        commands: [[...input.command]],
        secretEnv: {},
        workingDirectory: this.#repositoryRoot,
        timeoutMs: 120_000,
        maxOutputBytes: 1_048_576,
      },
      expectedEffects: [...input.effects],
      verification: [
        'git worktree list reflects the requested lifecycle change',
      ],
      scope: {
        threadId: input.scope.threadId,
        turnId: input.scope.turnId,
      },
      structureVersion: input.scope.structureVersion,
    }
  }
}
