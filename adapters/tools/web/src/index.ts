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
const MAX_DOWNLOAD_BYTES = 2_097_152

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
  /**
   * Delegated review: origins surfaced by the reviewed search backend stay
   * fetchable for their grant window even though they are not static.
   */
  readonly searchGrants?: SearchOriginGrants | undefined
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
  readonly #searchGrants: SearchOriginGrants | undefined
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
    this.#searchGrants = options.searchGrants
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
        `Fetch one web page and return its readable text (size-capped, trimmed at paragraph boundaries). ` +
        `Pages are readability-extracted (navigation removed, main/article content kept) and charset-aware (GBK/Big5 etc.); article links stay as Markdown [label](url) and the result leads with 原文链接/标题/摘要 — cite each item with its own 原文链接. ` +
        `RSS/Atom URLs return a parsed item list (title, link, date, summary) — prefer feeds for large or JS-rendered pages; repeated fetches within ~10 minutes are served from cache. ` +
        `Allowed origins (research channels configured by the host): ${[...this.#origins].join(', ')}; additionally, any origin returned by a recent web_search stays fetchable for a short window (delegated review). Other origins fail closed.`,
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
    if (!this.#origins.has(origin) && !this.#searchGrants?.has(origin)) {
      throw new Error(
        `web_fetch origin '${origin}' is not allowlisted; allowed: ${[...this.#origins].join(', ')} (or any origin returned by a recent web_search)`,
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
  /** Hard per-request timeout; the loop's abort signal still wins. */
  readonly fetchTimeoutMs?: number | undefined
  /** Short-lived page cache; 0 disables. Defaults to 10 minutes. */
  readonly cacheTtlMs?: number | undefined
  readonly cacheMaxEntries?: number | undefined
  /**
   * When provided, redirects are followed hop by hop and every hop's origin
   * must be on this list (ADR 0023 exact-origin discipline covers the whole
   * chain, not just the first request). Absent → redirects follow freely.
   */
  readonly allowedOrigins?: readonly string[] | undefined
  /** Successful searches grant their result origins to the fetch tool. */
  readonly searchGrants?: SearchOriginGrants | undefined
}

export interface WebSearchResult {
  readonly title: string
  readonly url: string
  readonly snippet: string
}

/**
 * Host-delegated review (ADR 0023): the operator reviewed the search
 * backend, so origins that backend surfaces become fetchable for a short
 * window. Read-only predicate consumed by the fetch adapter and the
 * network sandbox; grants carry a TTL and never outlive the process.
 */
export class SearchOriginGrants {
  readonly #expiryByOrigin = new Map<string, number>()
  readonly #ttlMs: number

  constructor(ttlMs = 15 * 60_000) {
    this.#ttlMs = ttlMs
  }

  grant(urls: readonly string[]): void {
    const until = Date.now() + this.#ttlMs
    for (const url of urls) {
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          continue
        }
        this.#expiryByOrigin.set(parsed.origin, until)
      } catch {
        // not a URL worth granting
      }
    }
  }

  has(origin: string): boolean {
    const until = this.#expiryByOrigin.get(origin)
    if (until === undefined) return false
    if (Date.now() > until) {
      this.#expiryByOrigin.delete(origin)
      return false
    }
    return true
  }

  get size(): number {
    return this.#expiryByOrigin.size
  }
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
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, decodeEntity)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim()
}

/** Common named HTML entities beyond the always-handled amp/lt/gt set. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  laquo: '«',
  raquo: '»',
  minus: '−',
  sup2: '²',
  sup3: '³',
  frac12: '½',
  euro: '€',
  pound: '£',
  yen: '¥',
  sect: '§',
  para: '¶',
  dagger: '†',
}

function decodeEntity(_match: string, body: string): string {
  if (body.startsWith('#x') || body.startsWith('#X')) {
    const code = Number.parseInt(body.slice(2), 16)
    return Number.isFinite(code) ? String.fromCodePoint(code) : body
  }
  if (body.startsWith('#')) {
    const code = Number.parseInt(body.slice(1), 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : body
  }
  const named = NAMED_ENTITIES[body.toLowerCase()]
  return named ?? body
}

/**
 * Readability-style main-content selection (dependency-free): chrome blocks
 * (nav/header/footer/aside/form) go first, then the largest <main>/<article>
 * region wins when one exists — homepages keep their headlines and drop the
 * navigation noise.
 */
export function extractMainHtml(html: string): string {
  const stripped = html.replace(
    /<(nav|header|footer|aside|form|svg)\b[^>]*>[\s\S]*?<\/\1>/gi,
    ' ',
  )
  const candidates: string[] = []
  for (const match of stripped.matchAll(
    /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/gi,
  )) {
    candidates.push(match[2] ?? '')
  }
  if (candidates.length === 0) return stripped
  // The largest region by tag-stripped length is the content, not a widget.
  const textLength = (value: string): number =>
    value.replace(/<[^>]+>/g, '').length
  return candidates.reduce((best, next) =>
    textLength(next) > textLength(best) ? next : best,
  )
}

/** Reads at most `maxBytes` from the response stream; flags truncation. */
async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = response.body?.getReader()
  if (reader === undefined) {
    const buffer = await response.arrayBuffer()
    const bytes = new Uint8Array(buffer).subarray(0, maxBytes)
    return {
      bytes: new Uint8Array(bytes),
      truncated: buffer.byteLength > maxBytes,
    }
  }
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  let settled = false
  while (total < maxBytes) {
    const read = await reader.read()
    if (read.done === true || read.value === undefined) {
      settled = true
      break
    }
    const room = maxBytes - total
    if (read.value.length > room) {
      chunks.push(read.value.subarray(0, room))
      total += room
      truncated = true
      settled = true
      await reader.cancel().catch(() => undefined)
      break
    }
    chunks.push(read.value)
    total += read.value.length
  }
  // A chunk boundary can fill the budget exactly; the cap only counts as
  // non-truncating when the stream itself ended within it. Re-reading a
  // cancelled stream returns done, so this probe must never run after the
  // overflow branch above settled the answer.
  if (!settled && total >= maxBytes) {
    const probe = await reader.read()
    truncated = probe.done !== true
    await reader.cancel().catch(() => undefined)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return { bytes, truncated }
}

const SUPPORTED_CHARSETS = new Set([
  'utf-8',
  'utf8',
  'gbk',
  'gb2312',
  'gb18030',
  'big5',
  'shift_jis',
  'shift-jis',
  'euc-jp',
  'euc-kr',
  'iso-8859-1',
  'windows-1252',
  'us-ascii',
])

/** Decodes bytes with the declared (or sniffed) charset; UTF-8 on failure. */
function decodeBytes(bytes: Uint8Array, charset: string): string {
  const label = charset.trim().toLowerCase().replaceAll('"', '')
  if (SUPPORTED_CHARSETS.has(label)) {
    try {
      return new TextDecoder(label, { fatal: false }).decode(bytes)
    } catch {
      // fall through to UTF-8
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

function charsetFromContentType(contentType: string): string | undefined {
  const match = /charset=([^;]+)/i.exec(contentType)
  return match?.[1]
}

function charsetFromHtmlHead(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 2048))
    .toLowerCase()
  const meta =
    /<meta[^>]+charset=["']?([a-z0-9_-]+)/.exec(head) ??
    /<\?xml[^>]+encoding=["']?([a-z0-9_-]+)/.exec(head)
  return meta?.[1]
}

/** Trims at a paragraph boundary instead of mid-sentence when over budget. */
function trimAtBoundary(
  text: string,
  limit: number,
): {
  text: string
  truncated: boolean
} {
  if (text.length <= limit) return { text, truncated: false }
  const window = text.slice(0, limit)
  const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'))
  const at = cut > limit * 0.5 ? cut : limit
  return { text: `${text.slice(0, at)}…[已按大小截断]`, truncated: true }
}

interface FeedItem {
  readonly title: string
  readonly link: string
  readonly date: string
  readonly summary: string
}

function stripCdata(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/\s+/g, ' ')
    .trim()
}

function firstTag(block: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(
    block,
  )
  return match === null ? '' : stripCdata(match[1] ?? '')
}

/** Dependency-free RSS 2.0 / Atom parser for feed-shaped responses. */
export function parseFeed(xml: string): {
  title: string
  items: readonly FeedItem[]
} {
  const channelTitle =
    firstTag(
      xml.slice(0, xml.search(/<(item|entry)\b/i) || xml.length),
      'title',
    ) || firstTag(xml, 'title')
  const items: FeedItem[] = []
  for (const match of xml.matchAll(
    /<item\b[^>]*>([\s\S]*?)<\/item>|<entry\b[^>]*>([\s\S]*?)<\/entry>/gi,
  )) {
    const block = match[1] ?? match[2] ?? ''
    let link = firstTag(block, 'link')
    if (link === '') {
      const href = /<link[^>]*href=["']([^"']+)["']/i.exec(block)
      link = href?.[1] ?? ''
    }
    const title = firstTag(block, 'title')
    if (link === '' && title === '') continue
    const date =
      firstTag(block, 'pubdate') ||
      firstTag(block, 'published') ||
      firstTag(block, 'updated') ||
      firstTag(block, 'dc:date')
    const summary = (
      firstTag(block, 'description') ||
      firstTag(block, 'summary') ||
      firstTag(block, 'content') ||
      firstTag(block, 'content:encoded')
    )
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    items.push({
      title,
      link,
      date,
      summary: summary.slice(0, 300),
    })
    if (items.length === 50) break
  }
  return { title: channelTitle, items }
}

function isFeedResponse(contentType: string, decoded: string): boolean {
  if (/\+xml|\/xml/i.test(contentType) && !/xhtml/i.test(contentType)) {
    return true
  }
  const head = decoded.slice(0, 1000)
  return /^\s*<\?xml[^>]*\?>\s*<(rss|feed)\b/i.test(head)
}

function extractMetaDescription(html: string): string {
  const match =
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(
      html,
    ) ??
    /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(
      html,
    )
  return match === null ? '' : decodeEntitiesAttribute(match[1] ?? '')
}

function decodeEntitiesAttribute(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
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
  readonly #fetchTimeoutMs: number
  readonly #cacheTtlMs: number
  readonly #cacheMaxEntries: number
  readonly #allowedOrigins: ReadonlySet<string> | undefined
  readonly #searchGrants: SearchOriginGrants | undefined
  readonly #cache = new Map<
    string,
    {
      readonly at: number
      readonly header: string
      readonly bodyText: string
      readonly output: Record<string, unknown>
    }
  >()

  constructor(options: FetchWebTransportOptions = {}) {
    this.#fetch = options.fetch ?? fetch.bind(globalThis)
    this.#backend = options.searchBackend
    this.#maxDownloadBytes = options.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES
    this.#fetchTimeoutMs = options.fetchTimeoutMs ?? 20_000
    this.#cacheTtlMs = options.cacheTtlMs ?? 600_000
    this.#cacheMaxEntries = options.cacheMaxEntries ?? 50
    this.#allowedOrigins =
      options.allowedOrigins === undefined
        ? undefined
        : new Set(options.allowedOrigins.map((origin) => originOf(origin)))
    this.#searchGrants = options.searchGrants
  }

  /**
   * Follows redirects one hop at a time, validating each hop's origin
   * against the allowlist. A redirect outside the reviewed origins fails
   * closed instead of silently leaking the request to an unreviewed host.
   */
  async #fetchFollowing(
    url: string,
    init: RequestInit,
  ): Promise<{ response: Response; finalUrl: string }> {
    if (this.#allowedOrigins === undefined) {
      const response = await this.#fetch(url, { ...init, redirect: 'follow' })
      return { response, finalUrl: response.url || url }
    }
    let current = url
    for (let hop = 0; hop < 8; hop += 1) {
      const response = await this.#fetch(current, {
        ...init,
        redirect: 'manual',
      })
      const location = response.headers.get('location')
      if (
        location === null ||
        (response.status >= 200 &&
          response.status < 400 &&
          response.status < 300)
      ) {
        return { response, finalUrl: response.url || current }
      }
      if (response.status < 300 || response.status >= 400) {
        return { response, finalUrl: response.url || current }
      }
      const next = new URL(location, current).toString()
      const origin = originOf(next)
      if (!this.#allowedOrigins.has(origin)) {
        throw new Error(
          `redirect ${response.status} to '${origin}' is outside the allowlisted origins`,
        )
      }
      current = next
    }
    throw new Error('too many redirects (limit 8)')
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
    const wanted =
      typeof payload.maxBytes === 'number' && payload.maxBytes > 0
        ? payload.maxBytes
        : DEFAULT_MAX_BYTES
    // The cache is keyed by URL alone: the stored text is re-trimmed per
    // request, so a different maxBytes still hits.
    const cached = this.#readCache(url)
    if (cached !== undefined) {
      const trimmed = trimAtBoundary(cached.bodyText, wanted)
      return {
        output: {
          ...cached.output,
          cached: true,
          returnedBytes: trimmed.text.length,
          contentTruncated: trimmed.truncated,
        },
        content:
          `${cached.header}\n\n[缓存命中] ` +
          `该页面在短时间内已抓取过，本次未重新下载。\n\n${trimmed.text}`,
        isError: false,
        verification: ['Served from the short-lived page cache'],
      }
    }
    const timeoutSignal = AbortSignal.timeout(this.#fetchTimeoutMs)
    const combined =
      signal === undefined
        ? timeoutSignal
        : AbortSignal.any([signal, timeoutSignal])
    try {
      const { response, finalUrl } = await this.#fetchFollowing(url, {
        signal: combined,
        redirect: 'follow',
        headers: {
          accept:
            'text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5',
          'user-agent': 'bee-agent/1.0 (personal agent; +local)',
        },
      })
      const contentType = response.headers.get('content-type') ?? ''
      const { bytes, truncated } = await readBounded(
        response,
        this.#maxDownloadBytes,
      )
      const charset =
        charsetFromContentType(contentType) ?? charsetFromHtmlHead(bytes)
      let decoded = decodeBytes(bytes, charset ?? 'utf-8')
      // A download cut inside an open <script>/<style>/<title> block would
      // leave the strip regexes unmatched and dump code into the text;
      // close the tags virtually so extraction still works.
      if (truncated) decoded += '</script></style></title>'

      if (isFeedResponse(contentType, decoded)) {
        const feed = parseFeed(decoded)
        const shown = feed.items.slice(0, 30)
        const content = [
          `[RSS/Atom 订阅源] 原文链接: ${finalUrl}`,
          ...(feed.title === '' ? [] : [`标题: ${feed.title}`]),
          `共解析 ${feed.items.length} 条（显示前 ${shown.length} 条）`,
          '',
          ...shown.map(
            (item, index) =>
              `${index + 1}. ${item.title}` +
              `${item.date === '' ? '' : `（${item.date}）`}\n` +
              `   原文链接: ${item.link}` +
              (item.summary === '' ? '' : `\n   摘要: ${item.summary}`),
          ),
        ].join('\n')
        const output: Record<string, unknown> = {
          url: finalUrl,
          status: response.status,
          contentType,
          kind: 'feed',
          items: feed.items.length,
          downloadTruncated: truncated,
        }
        if (response.ok) {
          this.#writeCache(url, {
            at: Date.now(),
            header: content.split('\n').slice(0, 2).join('\n'),
            bodyText: content,
            output: { ...output, cached: undefined },
          })
        }
        return {
          output,
          content: response.ok
            ? content
            : `HTTP ${response.status} from ${finalUrl}\n\n${content}`,
          isError: !response.ok,
          verification: [
            `Parsed ${feed.items.length} feed items from ${finalUrl}`,
          ],
        }
      }

      const isHtml =
        contentType.includes('html') || /^\s*<(!doctype|html)/i.test(decoded)
      const rawText = isHtml
        ? htmlToText(extractMainHtml(decoded), finalUrl)
        : decoded
      const trimmed = trimAtBoundary(rawText, wanted)
      const body = trimmed.text
      const title = isHtml ? extractTitle(decoded) : ''
      const description = isHtml ? extractMetaDescription(decoded) : ''
      // Source attribution travels with the content itself: the model
      // quotes what it read, so the original link (post-redirect final URL),
      // title, and meta description lead every fetch result.
      const header = [
        `原文链接: ${finalUrl}`,
        ...(title === '' ? [] : [`标题: ${title}`]),
        ...(description === '' || description === title
          ? []
          : [`摘要: ${description.slice(0, 200)}`]),
      ].join('\n')
      let content = `${header}\n\n${body}`
      if (isHtml && body.length < 300 && bytes.length > 10_000) {
        content +=
          '\n\n⚠ 该页面可能依赖 JavaScript 渲染，静态抓取只获得了以上少量文本；可尝试该站点的 RSS/Atom 订阅源。'
      }
      const output: Record<string, unknown> = {
        url: finalUrl,
        status: response.status,
        contentType,
        kind: isHtml ? 'html' : 'text',
        returnedBytes: body.length,
        contentTruncated: trimmed.truncated,
        downloadTruncated: truncated,
      }
      if (response.ok) {
        this.#writeCache(url, {
          at: Date.now(),
          header,
          bodyText: rawText,
          output: { ...output, cached: undefined },
        })
      }
      return {
        output,
        content: response.ok
          ? content
          : `HTTP ${response.status} from ${finalUrl}\n\n${content}`,
        isError: !response.ok,
        verification: [
          `Fetched ${finalUrl} as ${contentType || 'unknown type'} with source link attached`,
        ],
      }
    } catch (error) {
      if (signal?.aborted) {
        return errorResult(`web_fetch to ${url} was cancelled`)
      }
      if (timeoutSignal.aborted) {
        return errorResult(
          `web_fetch to ${url} timed out after ${this.#fetchTimeoutMs}ms`,
        )
      }
      return errorResult(
        `web_fetch to ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  #readCache(url: string):
    | {
        readonly at: number
        readonly header: string
        readonly bodyText: string
        readonly output: Record<string, unknown>
      }
    | undefined {
    if (this.#cacheTtlMs <= 0) return undefined
    const entry = this.#cache.get(url)
    if (entry === undefined) return undefined
    if (Date.now() - entry.at > this.#cacheTtlMs) {
      this.#cache.delete(url)
      return undefined
    }
    return entry
  }

  #writeCache(
    url: string,
    entry: {
      readonly at: number
      readonly header: string
      readonly bodyText: string
      readonly output: Record<string, unknown>
    },
  ): void {
    if (this.#cacheTtlMs <= 0) return
    this.#cache.delete(url)
    this.#cache.set(url, entry)
    while (this.#cache.size > this.#cacheMaxEntries) {
      const oldest = this.#cache.keys().next().value
      if (oldest === undefined) break
      this.#cache.delete(oldest)
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
      // Delegated review: the reviewed engine surfaced these origins, so
      // they become fetchable for the grant window.
      this.#searchGrants?.grant(results.map((result) => result.url))
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
