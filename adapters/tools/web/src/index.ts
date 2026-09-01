import { z } from 'zod'
import type { NetworkTransport } from '@bee-agent/execution'
import type { ActionResult } from '@bee-agent/execution'
import type {
  LlmToolCall,
  LlmToolSpec,
  ToolAdapter,
  ToolAuthorizationRule,
} from '@bee-agent/runtime'

/**
 * Web retrieval tools (ADR 0023): `web_fetch` reads one host-allowlisted
 * origin with a size-capped read-only GET, and `web_search` sends one
 * structured query to a configured engine. Both declare exactly one network
 * target and nothing else — no filesystem, no processes, no secrets — so
 * every action routes through the `AllowlistedNetworkSandbox`, whose
 * host-injected transport performs the actual HTTP. The model can never
 * pick an origin: `describe` rejects anything outside the host's list, and
 * the sandbox re-checks the target again before the transport runs.
 */

export const WEB_FETCH_TOOL_ID = 'web_fetch'
export const WEB_SEARCH_TOOL_ID = 'web_search'

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_BYTES = 65_536
const MAX_DOWNLOAD_BYTES = 262_144

// ---------------------------------------------------------------------------
// web_fetch
// ---------------------------------------------------------------------------

const FetchInputSchema = z.object({
  url: z.string().min(1),
  maxBytes: z.number().int().min(256).max(DEFAULT_MAX_BYTES).optional(),
})
export type WebFetchToolInput = z.infer<typeof FetchInputSchema>

export interface WebFetchToolOptions {
  /** Origins the host has reviewed; anything else fails closed. */
  readonly allowedOrigins: readonly string[]
  readonly maxTimeoutMs?: number | undefined
  readonly maxBytes?: number | undefined
}

function originOf(url: string): string {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`web_fetch supports http/https URLs only, got '${url}'`)
  }
  return parsed.origin
}

export class WebFetchToolAdapter implements ToolAdapter {
  readonly #origins: ReadonlySet<string>
  readonly #maxTimeoutMs: number
  readonly #maxBytes: number
  readonly spec: LlmToolSpec
  readonly authorization: ToolAuthorizationRule = {
    toolId: WEB_FETCH_TOOL_ID,
    decision: 'allow',
    reason:
      'Read-only, size-capped GET limited to the origins the host allowlisted',
  }

  constructor(options: WebFetchToolOptions) {
    const origins = options.allowedOrigins.map((origin) => originOf(origin))
    if (origins.length === 0) {
      throw new Error('web_fetch requires at least one allowed origin')
    }
    this.#origins = new Set(origins)
    this.#maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.spec = {
      id: WEB_FETCH_TOOL_ID,
      description:
        `Fetch one web page and return its readable text (size-capped). ` +
        `The text keeps article links as Markdown [label](url) and leads with the page-level source link — when you summarize items from the page, cite each item with its own 原文链接 from those Markdown links. ` +
        `Allowed origins (research channels configured by the host): ${[...this.#origins].join(', ')}. Any other origin fails closed.`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['url'],
        properties: {
          url: {
            type: 'string',
            description: 'Absolute http(s) URL on an allowed origin.',
          },
          maxBytes: {
            type: 'integer',
            minimum: 256,
            maximum: DEFAULT_MAX_BYTES,
            description: 'Cap on the returned text size in bytes.',
          },
        },
      },
    }
  }

  get allowedOrigins(): readonly string[] {
    return [...this.#origins]
  }

  describe(call: LlmToolCall) {
    if (call.toolId !== WEB_FETCH_TOOL_ID) {
      throw new Error(`web adapter cannot describe tool '${call.toolId}'`)
    }
    const input = FetchInputSchema.parse(call.input)
    const origin = originOf(input.url)
    if (!this.#origins.has(origin)) {
      throw new Error(
        `web_fetch origin '${origin}' is not allowlisted; allowed: ${[...this.#origins].join(', ')}`,
      )
    }
    return {
      capability: `tool:${WEB_FETCH_TOOL_ID}`,
      requirements: {
        readPaths: [],
        writePaths: [],
        networkTargets: [origin],
        commands: [],
        secretEnv: {},
        timeoutMs: this.#maxTimeoutMs,
        maxOutputBytes: Math.min(
          input.maxBytes ?? this.#maxBytes,
          DEFAULT_MAX_BYTES,
        ),
      },
      expectedEffects: [
        `Send one read-only GET to ${origin} (size-capped response)`,
      ],
      verification: [
        'HTTP status and bounded page text are returned to the model',
      ],
    }
  }

  async execute(): Promise<never> {
    throw new Error(
      'web_fetch actions must be executed by AllowlistedNetworkSandbox, not in process',
    )
  }

  concurrency(call: LlmToolCall): 'parallel' {
    if (call.toolId !== WEB_FETCH_TOOL_ID) {
      throw new Error(`web adapter cannot schedule tool '${call.toolId}'`)
    }
    return 'parallel'
  }
}

// ---------------------------------------------------------------------------
// web_search
// ---------------------------------------------------------------------------

const SearchInputSchema = z.object({
  query: z.string().min(1).max(400),
  maxResults: z.number().int().min(1).max(10).default(5),
})
export type WebSearchToolInput = z.infer<typeof SearchInputSchema>

export interface WebSearchToolOptions {
  /** The engine origin the host configured (SearxNG or Tavily base URL). */
  readonly engineOrigin: string
  readonly maxTimeoutMs?: number | undefined
}

export class WebSearchToolAdapter implements ToolAdapter {
  readonly #origin: string
  readonly #maxTimeoutMs: number
  readonly spec: LlmToolSpec
  readonly authorization: ToolAuthorizationRule = {
    toolId: WEB_SEARCH_TOOL_ID,
    decision: 'allow',
    reason:
      'One structured query to the single host-configured search engine; results are titles, URLs, and snippets',
  }

  constructor(options: WebSearchToolOptions) {
    this.#origin = originOf(options.engineOrigin)
    this.#maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.spec = {
      id: WEB_SEARCH_TOOL_ID,
      description:
        'Search the web through the configured engine and return ranked results (title, URL, snippet) for follow-up web_fetch calls.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 400 },
          maxResults: { type: 'integer', minimum: 1, maximum: 10 },
        },
      },
    }
  }

  get engineOrigin(): string {
    return this.#origin
  }

  describe(call: LlmToolCall) {
    if (call.toolId !== WEB_SEARCH_TOOL_ID) {
      throw new Error(`web adapter cannot describe tool '${call.toolId}'`)
    }
    SearchInputSchema.parse(call.input)
    return {
      capability: `tool:${WEB_SEARCH_TOOL_ID}`,
      requirements: {
        readPaths: [],
        writePaths: [],
        networkTargets: [this.#origin],
        commands: [],
        secretEnv: {},
        timeoutMs: this.#maxTimeoutMs,
        maxOutputBytes: DEFAULT_MAX_BYTES,
      },
      expectedEffects: [
        `Send one search query to ${this.#origin} (structured results only)`,
      ],
      verification: ['Ranked results with title, URL, and snippet return'],
    }
  }

  async execute(): Promise<never> {
    throw new Error(
      'web_search actions must be executed by AllowlistedNetworkSandbox, not in process',
    )
  }

  concurrency(): 'parallel' {
    return 'parallel'
  }
}

// ---------------------------------------------------------------------------
// The host-injected transport
// ---------------------------------------------------------------------------

export type WebSearchBackend =
  | { readonly kind: 'searxng'; readonly searchPath?: string | undefined }
  | { readonly kind: 'tavily'; readonly apiKey: string }

export interface FetchWebTransportOptions {
  readonly searchBackend?: WebSearchBackend | undefined
  /** Fetch implementation; defaults to the global fetch. */
  readonly fetch?: typeof fetch | undefined
  readonly maxDownloadBytes?: number | undefined
}

export interface WebSearchResult {
  readonly title: string
  readonly url: string
  readonly snippet: string
}

/**
 * Resolves an href against the page URL; non-navigational schemes stay
 * link-less. Returns undefined when the href carries no usable address.
 */
function resolveHref(
  href: string,
  baseUrl: string | undefined,
): string | undefined {
  const trimmed = href.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return undefined
  if (/^(javascript|mailto|tel|data):/i.test(trimmed)) return undefined
  try {
    return new URL(trimmed, baseUrl).toString()
  } catch {
    return undefined
  }
}

/**
 * Minimal, dependency-free HTML → readable text conversion. Anchors become
 * Markdown links — `[label](absolute URL)` — so per-article source links
 * survive the tag stripping and the model can cite each item it read.
 * Relative hrefs resolve against `baseUrl` (the fetched page's URL).
 */
export function htmlToText(html: string, baseUrl?: string | undefined): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(
      /<a\s[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
      (_match, _quote: string, href: string, inner: string) => {
        const url = resolveHref(href, baseUrl)
        const label =
          inner
            .replace(/<[^>]+>/g, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/\s+/g, ' ')
            .trim() || url
        if (label === undefined) return ' '
        return url === undefined ? label : `[${label}](${url})`
      },
    )
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim()
}

/** Best-effort <title> extraction for source attribution. */
function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (match === null) return ''
  return match[1]!.replace(/\s+/g, ' ').trim().slice(0, 200)
}

function errorResult(message: string): ActionResult {
  return { output: {}, content: message, isError: true, verification: [] }
}

/**
 * The only network client in the web toolchain (ADR 0023: transports are
 * host-injected). The sandbox hands it the predeclared origin plus the
 * action payload; the transport re-validates that a payload URL matches the
 * target before any request goes out, caps the download, and never puts
 * credentials in the payload or the Chronicle-visible result.
 */
export class FetchWebTransport implements NetworkTransport {
  readonly #fetch: typeof fetch
  readonly #backend: WebSearchBackend | undefined
  readonly #maxDownloadBytes: number

  constructor(options: FetchWebTransportOptions = {}) {
    this.#fetch = options.fetch ?? fetch.bind(globalThis)
    this.#backend = options.searchBackend
    this.#maxDownloadBytes = options.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES
  }

  async request(input: {
    readonly target: string
    readonly payload: unknown
    readonly signal?: AbortSignal | undefined
    readonly secrets: ReadonlyMap<string, string>
  }): Promise<ActionResult> {
    // The sandbox hands over the ActionRequest input, which wraps the
    // model's tool arguments as { call: { toolId, input } }; accept the
    // bare arguments too so the transport stays testable.
    const wrapped = input.payload as
      { readonly call?: { readonly input?: unknown } | undefined } | undefined
    const payload = (wrapped?.call?.input ?? input.payload) as
      | {
          readonly url?: unknown
          readonly query?: unknown
          readonly maxResults?: unknown
        }
      | undefined
    if (payload?.url !== undefined && typeof payload.url === 'string') {
      return this.#fetchPage(payload.url, input.target, payload, input.signal)
    }
    if (payload?.query !== undefined && typeof payload.query === 'string') {
      return this.#search(payload, input.target, input.signal)
    }
    return errorResult(
      'web transport received neither a fetch url nor a search query',
    )
  }

  async #fetchPage(
    url: string,
    target: string,
    payload: {
      readonly url?: unknown
      readonly query?: unknown
      readonly maxResults?: unknown
      readonly maxBytes?: unknown
    },
    signal: AbortSignal | undefined,
  ): Promise<ActionResult> {
    let origin: string
    try {
      origin = originOf(url)
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error))
    }
    if (origin !== target) {
      return errorResult(
        `web_fetch URL origin '${origin}' does not match the authorized target '${target}'`,
      )
    }
    try {
      const response = await this.#fetch(url, {
        signal: signal ?? null,
        redirect: 'follow',
        headers: {
          accept:
            'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5',
          'user-agent': 'bee-agent/1.0 (personal agent; +local)',
        },
      })
      const contentType = response.headers.get('content-type') ?? ''
      const raw = sliceToBytes(await response.text(), this.#maxDownloadBytes)
      const wanted =
        typeof payload.maxBytes === 'number' && payload.maxBytes > 0
          ? payload.maxBytes
          : DEFAULT_MAX_BYTES
      const isHtml =
        contentType.includes('html') || /^\s*<(!doctype|html)/i.test(raw)
      const body = (isHtml ? htmlToText(raw, response.url || url) : raw).slice(
        0,
        wanted,
      )
      // Source attribution travels with the content itself: the model
      // quotes what it read, so the original link (post-redirect final URL)
      // and title lead every fetch result.
      const finalUrl = response.url || url
      const title = isHtml ? extractTitle(raw) : ''
      const header = [
        `原文链接: ${finalUrl}`,
        ...(title === '' ? [] : [`标题: ${title}`]),
      ].join('\n')
      if (!response.ok) {
        return {
          output: { url, status: response.status, contentType },
          content: `HTTP ${response.status} from ${finalUrl}\n\n${body}`,
          isError: response.status >= 400,
          verification: [],
        }
      }
      return {
        output: {
          url: finalUrl,
          status: response.status,
          contentType,
          returnedBytes: body.length,
        },
        content: `${header}\n\n${body}`,
        verification: [
          `Fetched ${finalUrl} as ${contentType || 'unknown type'} with source link attached`,
        ],
      }
    } catch (error) {
      if (signal?.aborted) {
        return errorResult(`web_fetch to ${url} was cancelled`)
      }
      return errorResult(
        `web_fetch to ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async #search(
    payload: { query?: unknown; maxResults?: unknown },
    target: string,
    signal: AbortSignal | undefined,
  ): Promise<ActionResult> {
    const query = String(payload.query ?? '')
    const maxResults =
      typeof payload.maxResults === 'number' && payload.maxResults > 0
        ? Math.min(10, Math.trunc(payload.maxResults))
        : 5
    const backend = this.#backend
    if (backend === undefined) {
      return errorResult('No search backend is configured on this host')
    }
    try {
      const results =
        backend.kind === 'searxng'
          ? await this.#searxng(backend, query, maxResults, target, signal)
          : await this.#tavily(backend, query, maxResults, target, signal)
      if (results.length === 0) {
        return {
          output: { query, results: 0 },
          content: `No results for '${query}'.`,
          verification: [],
        }
      }
      const content = results
        .map(
          (result, index) =>
            `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`,
        )
        .join('\n\n')
      return {
        output: { query, results: results.length },
        content,
        verification: [
          `Search engine returned ${results.length} results for '${query}'`,
        ],
      }
    } catch (error) {
      if (signal?.aborted) {
        return errorResult(`web_search for '${query}' was cancelled`)
      }
      return errorResult(
        `web_search for '${query}' failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async #searxng(
    backend: Extract<WebSearchBackend, { kind: 'searxng' }>,
    query: string,
    maxResults: number,
    target: string,
    signal: AbortSignal | undefined,
  ): Promise<readonly WebSearchResult[]> {
    const path = backend.searchPath ?? '/search'
    const url = new URL(`${target}${path}`)
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'json')
    const response = await this.#fetch(url, {
      signal: signal ?? null,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      throw new Error(`SearxNG answered HTTP ${response.status}`)
    }
    const body = (await response.json()) as {
      results?: readonly {
        title?: unknown
        url?: unknown
        content?: unknown
      }[]
    }
    return (body.results ?? [])
      .slice(0, maxResults)
      .map((result) => ({
        title: String(result.title ?? ''),
        url: String(result.url ?? ''),
        snippet: String(result.content ?? '').slice(0, 400),
      }))
      .filter((result) => result.url !== '')
  }

  async #tavily(
    backend: Extract<WebSearchBackend, { kind: 'tavily' }>,
    query: string,
    maxResults: number,
    target: string,
    signal: AbortSignal | undefined,
  ): Promise<readonly WebSearchResult[]> {
    // The key lives in the transport closure only — never in the action
    // payload, the requirements, or any Chronicle-visible event.
    const response = await this.#fetch(new URL(`${target}/search`), {
      signal: signal ?? null,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${backend.apiKey}`,
      },
      body: JSON.stringify({ query, max_results: maxResults }),
    })
    if (!response.ok) {
      throw new Error(`Tavily answered HTTP ${response.status}`)
    }
    const body = (await response.json()) as {
      results?: readonly {
        title?: unknown
        url?: unknown
        content?: unknown
      }[]
    }
    return (body.results ?? [])
      .slice(0, maxResults)
      .map((result) => ({
        title: String(result.title ?? ''),
        url: String(result.url ?? ''),
        snippet: String(result.content ?? '').slice(0, 400),
      }))
      .filter((result) => result.url !== '')
  }
}

function sliceToBytes(text: string, maxBytes: number): string {
  return text.length <= maxBytes ? text : text.slice(0, maxBytes)
}
