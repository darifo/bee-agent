import type {
  MemoryClaim,
  MemoryContext,
  MemoryContextInput,
  MemoryConsolidationReport,
  MemoryDerivationInput,
  MemoryDerivationResult,
  MemoryExport,
  MemoryHealth,
  MemoryIngestInput,
  MemoryIngestResult,
  MemoryQuery,
  MemoryRepresentation,
} from '@bee-agent/knowledge'
import type { MemoryBridgeTransport } from './bridge-transport.ts'

/**
 * The HTTP bridge transport (v1 refactor plan §5.5 WF4-C): speaks a small,
 * documented REST contract so any compatible memory service can sit behind
 * {@link RemoteMemoryProvider}. The wire shapes are the knowledge-package
 * JSON types verbatim — one JSON object per request/response, no envelopes.
 *
 * | Operation        | Request                          |
 * | ---------------- | -------------------------------- |
 * | ingest           | POST /memory/ingest              |
 * | query            | POST /memory/query → {claims}    |
 * | buildContext     | POST /memory/context             |
 * | representation   | POST /memory/representation      |
 * | derive           | POST /memory/derive              |
 * | consolidate      | POST /memory/consolidate         |
 * | retract          | POST /memory/retract             |
 * | export           | GET  /memory/export              |
 * | health           | GET  /memory/health              |
 */

export class MemoryTransportError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'MemoryTransportError'
  }
}

export interface FetchMemoryTransportOptions {
  /** Base URL of the remote memory service, without a trailing slash. */
  readonly baseUrl: string
  /** Optional bearer token sent on every request. */
  readonly token?: string | undefined
  /** Injectable fetch for tests; defaults to the global fetch. */
  readonly fetch?: typeof fetch | undefined
}

export class FetchMemoryTransport implements MemoryBridgeTransport {
  readonly #baseUrl: string
  readonly #token: string | undefined
  readonly #fetch: typeof fetch

  constructor(options: FetchMemoryTransportOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.#token = options.token
    this.#fetch = options.fetch ?? fetch
  }

  ingest(input: MemoryIngestInput): Promise<MemoryIngestResult> {
    return this.#request('POST', '/memory/ingest', input)
  }

  async query(query: MemoryQuery): Promise<readonly MemoryClaim[]> {
    const response = await this.#request<{ claims: MemoryClaim[] }>(
      'POST',
      '/memory/query',
      query,
    )
    return response.claims
  }

  buildContext(input: MemoryContextInput): Promise<MemoryContext> {
    return this.#request('POST', '/memory/context', input)
  }

  getRepresentation(
    claimIds: readonly string[],
  ): Promise<MemoryRepresentation> {
    return this.#request('POST', '/memory/representation', { claimIds })
  }

  derive(input: MemoryDerivationInput): Promise<MemoryDerivationResult> {
    return this.#request('POST', '/memory/derive', input)
  }

  consolidate(): Promise<MemoryConsolidationReport> {
    return this.#request('POST', '/memory/consolidate', {})
  }

  retract(claimId: string, reason?: string): Promise<MemoryClaim> {
    return this.#request('POST', '/memory/retract', { claimId, reason })
  }

  export(): Promise<MemoryExport> {
    return this.#request('GET', '/memory/export')
  }

  health(): Promise<MemoryHealth> {
    return this.#request('GET', '/memory/health')
  }

  async #request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    let response: Response
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(this.#token === undefined
            ? {}
            : { authorization: `Bearer ${this.#token}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error) {
      throw new MemoryTransportError(
        0,
        `Memory transport '${method} ${path}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    if (!response.ok) {
      throw new MemoryTransportError(
        response.status,
        `Memory transport '${method} ${path}' returned ${response.status}`,
      )
    }
    return (await response.json()) as T
  }
}
