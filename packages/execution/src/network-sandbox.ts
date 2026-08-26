import type {
  ActionRequest,
  ActionResult,
  SandboxCapabilityReport,
  SandboxProvider,
  WorldSnapshot,
} from './execution-world.ts'

export interface NetworkTransport {
  request(input: {
    readonly target: string
    readonly payload: unknown
    readonly signal?: AbortSignal | undefined
    readonly secrets: ReadonlyMap<string, string>
  }): Promise<ActionResult>
}

/**
 * Enforcing network provider: the transport receives only a predeclared,
 * exact target. It cannot select a URL from model-controlled payload data.
 */
export class AllowlistedNetworkSandbox implements SandboxProvider {
  readonly #targets: ReadonlySet<string>
  readonly #transport: NetworkTransport

  constructor(targets: readonly string[], transport: NetworkTransport) {
    if (targets.length === 0)
      throw new Error('At least one network target is required')
    this.#targets = new Set(targets.map((target) => new URL(target).origin))
    this.#transport = transport
  }

  async execute(
    request: ActionRequest,
    options: {
      readonly signal?: AbortSignal | undefined
      readonly secrets: ReadonlyMap<string, string>
    },
  ): Promise<ActionResult> {
    if (request.requirements.networkTargets.length !== 1)
      throw new Error('Network actions must declare exactly one target')
    if (
      request.requirements.commands.length > 0 ||
      request.requirements.readPaths.length > 0 ||
      request.requirements.writePaths.length > 0
    )
      throw new Error(
        'Network sandbox does not accept process or filesystem effects',
      )
    const target = new URL(request.requirements.networkTargets[0] as string)
      .origin
    if (!this.#targets.has(target))
      throw new Error(`Network target '${target}' is not allowlisted`)
    return this.#transport.request({
      target,
      payload: request.input,
      signal: options.signal,
      secrets: options.secrets,
    })
  }

  snapshot(request: ActionRequest): Promise<WorldSnapshot> {
    return Promise.resolve({
      ref: `network:${request.id}`,
      capturedAt: new Date().toISOString(),
      state: { targets: request.requirements.networkTargets },
    })
  }

  diff(): Promise<unknown> {
    return Promise.resolve({ kind: 'remote-effect', locallyMutated: false })
  }

  capabilities(): Promise<SandboxCapabilityReport> {
    return Promise.resolve({
      provider: 'allowlisted-network',
      filesystemIsolation: false,
      networkIsolation: true,
      processIsolation: false,
    })
  }
}
