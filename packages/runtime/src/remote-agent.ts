import type { ActionResult } from '@bee-agent/execution'
import type { LlmToolCall, LlmToolSpec } from './llm-runtime.ts'
import type { ToolAdapter } from './tool-execution.ts'

export interface RemoteAgentManifest {
  readonly id: string
  readonly endpoint: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly secretEnv?: Readonly<Record<string, string>> | undefined
}

/**
 * RemoteAgent v2 declaration. Transport is deliberately absent: the expanded
 * request is executed by AllowlistedNetworkSandbox inside ExecutionWorld.
 */
export class RemoteAgentAdapter implements ToolAdapter {
  readonly spec: LlmToolSpec
  readonly authorization = {
    toolId: '',
    decision: 'ask' as const,
    reason: 'Remote agent call crosses a device/network trust boundary',
  }
  readonly #manifest: RemoteAgentManifest
  readonly #origin: string

  constructor(manifest: RemoteAgentManifest) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(manifest.id))
      throw new Error(
        'Remote agent id must be a safe 1-64 character identifier',
      )
    this.#origin = new URL(manifest.endpoint).origin
    if (new URL(manifest.endpoint).protocol !== 'https:')
      throw new Error('Remote agent endpoint must use HTTPS')
    this.#manifest = manifest
    this.spec = {
      id: `remote_agent__${manifest.id}`,
      description: manifest.description,
      inputSchema: manifest.inputSchema,
    }
    this.authorization = { ...this.authorization, toolId: this.spec.id }
  }

  describe(call: LlmToolCall) {
    this.#assertCall(call)
    return {
      capability: `tool:${this.spec.id}`,
      requirements: {
        readPaths: [],
        writePaths: [],
        networkTargets: [this.#origin],
        commands: [],
        secretEnv: { ...(this.#manifest.secretEnv ?? {}) },
        timeoutMs: 120_000,
        maxOutputBytes: 2_097_152,
      },
      expectedEffects: [
        `Send a bounded child request to remote agent '${this.#manifest.id}'`,
      ],
      verification: [
        'Validate the structured remote outcome and preserve parent/child lineage',
      ],
    }
  }

  execute(): Promise<ActionResult> {
    return Promise.reject(
      new Error('RemoteAgentAdapter must execute through a network sandbox'),
    )
  }

  present(result: ActionResult, call: LlmToolCall): ActionResult {
    this.#assertCall(call)
    return {
      ...result,
      output: {
        remoteAgentId: this.#manifest.id,
        endpointOrigin: this.#origin,
        result: result.output,
      },
    }
  }

  #assertCall(call: LlmToolCall): void {
    if (call.toolId !== this.spec.id)
      throw new Error(`Remote agent adapter cannot execute '${call.toolId}'`)
  }
}
