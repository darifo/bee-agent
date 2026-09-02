import type {
  ActionRequest,
  ActionResult,
  AuthorizationDecision,
  PermissionSnapshot,
  SandboxCapabilityReport,
  SandboxProvider,
  SnapshotAuthorizationPolicy,
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
export interface DynamicOriginSource {
  /** Consulted alongside the static list; short-lived, host-delegated. */
  has(origin: string): boolean
}

export class AllowlistedNetworkSandbox implements SandboxProvider {
  readonly #targets: ReadonlySet<string>
  readonly #dynamic: DynamicOriginSource | undefined
  readonly #transport: NetworkTransport

  constructor(
    targets: readonly string[],
    transport: NetworkTransport,
    dynamicOrigins?: DynamicOriginSource,
  ) {
    if (targets.length === 0)
      throw new Error('At least one network target is required')
    this.#targets = new Set(targets.map((target) => new URL(target).origin))
    this.#dynamic = dynamicOrigins
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
    if (!this.#targets.has(target) && !(this.#dynamic?.has(target) ?? false))
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

/**
 * Decorator policy for durable user grants: a remembered approval relaxes
 * the wrapped policy's `ask` to `allow` for that capability. `deny` is
 * never overridden — a grant cannot outrank a refusal from any layer.
 */
export class PersistedGrantPolicy implements SnapshotAuthorizationPolicy {
  readonly #inner: SnapshotAuthorizationPolicy
  readonly #grants: ReadonlySet<string>

  constructor(inner: SnapshotAuthorizationPolicy, grants: ReadonlySet<string>) {
    this.#inner = inner
    this.#grants = grants
  }

  authorize(request: ActionRequest): AuthorizationDecision {
    if (!this.#grants.has(request.capability)) {
      return this.#inner.authorize(request)
    }
    const inner = this.#inner.authorize(request)
    if (inner.decision === 'deny') return inner
    return {
      decision: 'allow',
      reason: `用户已持久授权 '${request.capability}'（内层决定 ${inner.decision}）`,
    }
  }

  snapshot(request: ActionRequest): PermissionSnapshot {
    const inner = this.#inner.snapshot(request)
    if (!this.#grants.has(request.capability)) return inner
    if (inner.decision === 'deny') return inner
    return {
      ...inner,
      decision: 'allow',
      reason: `用户已持久授权 '${request.capability}'`,
      layers: [
        ...inner.layers,
        {
          id: 'persisted-grant',
          decision: 'allow' as const,
          reason: `用户记忆授权覆盖了 ${inner.decision}`,
        },
      ],
    }
  }
}
