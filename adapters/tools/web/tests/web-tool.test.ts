import { describe, expect, it, vi } from 'vitest'
import {
  FetchWebTransport,
  WEB_FETCH_TOOL_ID,
  WEB_SEARCH_TOOL_ID,
  SearchOriginGrants,
  WebFetchToolAdapter,
  WebSearchToolAdapter,
  htmlToText,
} from '../src/index.ts'

function call(
  toolId: string,
  input: unknown,
): Parameters<WebFetchToolAdapter['describe']>[0] {
  return {
    callId: 'c1',
    toolId,
    input,
  } as Parameters<WebFetchToolAdapter['describe']>[0]
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * ADR 0023 contract: the model can never pick an origin. describe() fails
 * closed outside the host's allowlist, the sandbox declaration carries
 * exactly one network target and nothing else, and the transport re-checks
 * the payload URL against the authorized target before any request goes
 * out.
 */
describe('web tool adapters', () => {
  it('declares exactly one network target for an allowlisted fetch', () => {
    const adapter = new WebFetchToolAdapter({
      allowedOrigins: ['https://example.com'],
    })
    expect(adapter.spec.id).toBe(WEB_FETCH_TOOL_ID)
    // The description enumerates the channels so the model knows where it
    // may fetch without trial and error.
    expect(adapter.spec.description).toContain(
      'Allowed origins (research channels configured by the host): https://example.com',
    )
    expect(adapter.authorization.decision).toBe('allow')
    expect(
      adapter.concurrency?.(
        call(WEB_FETCH_TOOL_ID, { url: 'https://example.com/a' }),
      ),
    ).toBe('parallel')

    const descriptor = adapter.describe(
      call(WEB_FETCH_TOOL_ID, {
        url: 'https://example.com/news/world?lang=zh',
      }),
    )
    expect(descriptor.requirements.networkTargets).toEqual([
      'https://example.com',
    ])
    expect(descriptor.requirements.readPaths).toEqual([])
    expect(descriptor.requirements.writePaths).toEqual([])
    expect(descriptor.requirements.commands).toEqual([])
    expect(descriptor.requirements.secretEnv).toEqual({})
  })

  it('rejects origins outside the allowlist and non-http schemes', () => {
    const adapter = new WebFetchToolAdapter({
      allowedOrigins: ['https://example.com'],
    })
    expect(() =>
      adapter.describe(
        call(WEB_FETCH_TOOL_ID, { url: 'https://evil.example/x' }),
      ),
    ).toThrow(/not allowlisted/)
    expect(() =>
      adapter.describe(call(WEB_FETCH_TOOL_ID, { url: 'file:///etc/passwd' })),
    ).toThrow(/http\/https/)
    expect(() => new WebFetchToolAdapter({ allowedOrigins: [] })).toThrow(
      /at least one/,
    )
  })

  it('declares the single configured engine origin for searches', () => {
    const adapter = new WebSearchToolAdapter({
      engineOrigin: 'http://127.0.0.1:8888',
    })
    expect(adapter.spec.id).toBe(WEB_SEARCH_TOOL_ID)
    const descriptor = adapter.describe(
      call(WEB_SEARCH_TOOL_ID, { query: '国际局势', maxResults: 3 }),
    )
    expect(descriptor.requirements.networkTargets).toEqual([
      'http://127.0.0.1:8888',
    ])
    expect(descriptor.requirements.commands).toEqual([])
    expect(() =>
      adapter.describe(call(WEB_SEARCH_TOOL_ID, { query: '' })),
    ).toThrow()
  })
})

describe('FetchWebTransport', () => {
  it('fetches a page, strips HTML, and caps the returned text', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          '<html><head><title>  World  News </title><style>.x{}</style></head><body><script>bad()</script>' +
            '<h1>World News</h1>' +
            '<h2><a href="/news/articles/a1">Nepal floods death toll passes 1,000</a></h2>' +
            '<p>Paragraph one. <a href="javascript:void(0)">skip</a></p><p>Paragraph two.</p>' +
            '</body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        ),
    )
    const transport = new FetchWebTransport({ fetch: fetchImpl })
    const result = await transport.request({
      target: 'https://example.com',
      payload: { url: 'https://example.com/news', maxBytes: 4096 },
      secrets: new Map(),
    })
    expect(result.isError).toBe(false)
    // The source link leads the content so the model can always cite it.
    expect(
      result.content.startsWith('原文链接: https://example.com/news'),
    ).toBe(true)
    expect(result.content).toContain('标题: World News')
    // Per-article links survive as absolute Markdown links.
    expect(result.content).toContain(
      '[Nepal floods death toll passes 1,000](https://example.com/news/articles/a1)',
    )
    // Non-navigational anchors lose the link but keep the page text.
    expect(result.content).not.toContain('javascript:')
    expect(result.content).toContain('World News')
    expect(result.content).toContain('Paragraph one.')
    expect(result.content).not.toContain('bad()')
    expect((result.output as { status: number }).status).toBe(200)
  })

  it('refuses a payload URL whose origin differs from the authorized target', async () => {
    const fetchImpl = vi.fn()
    const transport = new FetchWebTransport({ fetch: fetchImpl })
    const result = await transport.request({
      target: 'https://example.com',
      payload: { url: 'https://evil.example/exfil' },
      secrets: new Map(),
    })
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/does not match the authorized target/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('queries a SearxNG backend and formats ranked results', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        results: [
          {
            title: 'World news today',
            url: 'https://example.com/world',
            content: 'Summary of international affairs.',
          },
          { title: 'No URL', url: '', content: 'dropped' },
        ],
      }),
    )
    const transport = new FetchWebTransport({
      fetch: fetchImpl as unknown as typeof fetch,
      searchBackend: { kind: 'searxng' },
    })
    const result = await transport.request({
      target: 'http://127.0.0.1:8888',
      payload: { query: '国际局势', maxResults: 5 },
      secrets: new Map(),
    })
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('1. World news today')
    expect(result.content).toContain('https://example.com/world')
    expect(result.content).toContain('Summary of international affairs.')
    expect(result.content).not.toContain('No URL')
    const requested = String(
      (fetchImpl.mock.calls[0] as unknown as unknown[])[0],
    )
    expect(requested).toContain('format=json')
    expect(requested).toContain(encodeURIComponent('国际局势'))
  })

  it('unwraps the ActionRequest payload shape the sandbox delivers', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        results: [{ title: 'T', url: 'https://e.com/a', content: 'S' }],
      }),
    )
    const transport = new FetchWebTransport({
      fetch: fetchImpl as unknown as typeof fetch,
      searchBackend: { kind: 'searxng' },
    })
    const search = await transport.request({
      target: 'http://127.0.0.1:8888',
      payload: {
        call: {
          callId: 'c1',
          toolId: 'web_search',
          input: { query: 'q', maxResults: 2 },
        },
      },
      secrets: new Map(),
    })
    expect(search.isError).toBeUndefined()
    expect(search.content).toContain('https://e.com/a')

    const page = await transport.request({
      target: 'https://e.com',
      payload: {
        call: {
          callId: 'c2',
          toolId: 'web_fetch',
          input: { url: 'https://e.com/a' },
        },
      },
      secrets: new Map(),
    })
    expect(page.isError).toBe(false)
  })

  it('sends the Tavily key only in the transport, never in the payload', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        results: [
          {
            title: 'T',
            url: 'https://example.com/t',
            content: 'S',
          },
        ],
      }),
    )
    const transport = new FetchWebTransport({
      fetch: fetchImpl as unknown as typeof fetch,
      searchBackend: { kind: 'tavily', apiKey: 'tvly-secret' },
    })
    const result = await transport.request({
      target: 'https://api.tavily.com',
      payload: { query: 'q' },
      secrets: new Map(),
    })
    expect(result.isError).toBeUndefined()
    const init = (
      fetchImpl.mock.calls[0] as unknown as unknown[]
    )[1] as unknown as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer tvly-secret')
    expect(JSON.stringify(init.body)).not.toContain('tvly-secret')
    expect(result.content).not.toContain('tvly-secret')
  })

  it('surfaces fetch failures as error results, not throws', async () => {
    const transport = new FetchWebTransport({
      fetch: vi.fn(async () => {
        throw new Error('network down')
      }),
    })
    const result = await transport.request({
      target: 'https://example.com',
      payload: { url: 'https://example.com/x' },
      secrets: new Map(),
    })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('network down')
  })
})

describe('FetchWebTransport optimizations', () => {
  it('decodes GBK pages instead of mojibake', async () => {
    // "中文" encoded in GBK: D6D0 CEC4.
    const gbkBytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])
    const fetchImpl = vi.fn(
      async () =>
        new Response(gbkBytes, {
          headers: { 'content-type': 'text/html; charset=GBK' },
        }),
    )
    const transport = new FetchWebTransport({
      fetch: fetchImpl as unknown as typeof fetch,
    })
    const result = await transport.request({
      target: 'https://news.example.cn',
      payload: { url: 'https://news.example.cn/hello' },
      secrets: new Map(),
    })
    expect(result.content).toContain('中文')
  })

  it('parses RSS feeds into a structured item list with links', async () => {
    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Guardian World</title>
<item><title>Nepal floods</title><link>https://www.theguardian.com/world/a1</link><pubDate>Tue, 01 Sep 2026 08:00:00 GMT</pubDate><description>Death toll rises.</description></item>
<item><title>UN reparations</title><link>https://www.theguardian.com/world/a2</link><description><![CDATA[CERD <b>guidance</b> issued.]]></description></item>
</channel></rss>`
    const fetchImpl = vi.fn(
      async () =>
        new Response(rss, {
          headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
        }),
    )
    const transport = new FetchWebTransport({
      fetch: fetchImpl as unknown as typeof fetch,
    })
    const result = await transport.request({
      target: 'https://www.theguardian.com',
      payload: { url: 'https://www.theguardian.com/world/rss' },
      secrets: new Map(),
    })
    expect(result.content).toContain('[RSS/Atom 订阅源]')
    expect(result.content).toContain('标题: Guardian World')
    expect(result.content).toContain(
      '1. Nepal floods（Tue, 01 Sep 2026 08:00:00 GMT）',
    )
    expect(result.content).toContain(
      '原文链接: https://www.theguardian.com/world/a1',
    )
    expect(result.content).toContain('摘要: Death toll rises.')
    // CDATA + inline tags are stripped in summaries.
    expect(result.content).toContain('摘要: CERD guidance issued.')
    expect((result.output as { items: number }).items).toBe(2)
  })

  it('extracts main content and drops navigation chrome', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          '<html><body>' +
            '<nav><a href="/home">Home</a><a href="/sport">Sport</a></nav>' +
            '<main><h1>Big Story</h1><p>The real content is here.</p></main>' +
            '<footer>Copyright junk</footer>' +
            '</body></html>',
          { headers: { 'content-type': 'text/html' } },
        ),
    )
    const transport = new FetchWebTransport({
      fetch: fetchImpl as unknown as typeof fetch,
    })
    const result = await transport.request({
      target: 'https://example.com',
      payload: { url: 'https://example.com/story' },
      secrets: new Map(),
    })
    expect(result.content).toContain('Big Story')
    expect(result.content).toContain('The real content is here.')
    expect(result.content).not.toContain('Home')
    expect(result.content).not.toContain('Copyright junk')
  })

  it('serves repeated fetches from the short-TTL cache', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('<main><p>Once</p></main>', {
          headers: { 'content-type': 'text/html' },
        }),
    )
    const transport = new FetchWebTransport({
      fetch: fetchImpl as unknown as typeof fetch,
    })
    const first = await transport.request({
      target: 'https://example.com',
      payload: { url: 'https://example.com/cached' },
      secrets: new Map(),
    })
    const second = await transport.request({
      target: 'https://example.com',
      payload: { url: 'https://example.com/cached' },
      secrets: new Map(),
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(first.output).not.toHaveProperty('cached')
    expect((second.output as { cached?: boolean }).cached).toBe(true)
    expect(second.content).toContain('[缓存命中]')
    expect(
      second.content.endsWith(
        first.content.split('\n\n').slice(2).join('\n\n') || '',
      ),
    ).toBe(true)
  })

  it('enforces its own timeout when the server hangs', async () => {
    const fetchImpl = vi.fn(
      (_input: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    )
    const transport = new FetchWebTransport({
      fetch: fetchImpl as unknown as typeof fetch,
      fetchTimeoutMs: 30,
    })
    const result = await transport.request({
      target: 'https://slow.example.com',
      payload: { url: 'https://slow.example.com/x' },
      secrets: new Map(),
    })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('timed out after 30ms')
  })

  it('warns honestly when a page looks JavaScript-rendered', async () => {
    const shell =
      '<html><body><div id="root"></div>' +
      '<script>/*' +
      'x'.repeat(12_000) +
      '*/</script></body></html>'
    const fetchImpl = vi.fn(
      async () =>
        new Response(shell, { headers: { 'content-type': 'text/html' } }),
    )
    const transport = new FetchWebTransport({
      fetch: fetchImpl as unknown as typeof fetch,
    })
    const result = await transport.request({
      target: 'https://spa.example.com',
      payload: { url: 'https://spa.example.com/' },
      secrets: new Map(),
    })
    expect(result.content).toContain('JavaScript 渲染')
    expect(result.content).toContain('RSS/Atom')
  })

  it('trims long text at a paragraph boundary with a marker', async () => {
    const paragraphs = Array.from(
      { length: 200 },
      (_, i) => `<p>段落 ${i}，内容填充。</p>`,
    ).join('')
    const fetchImpl = vi.fn(
      async () =>
        new Response(`<main>${paragraphs}</main>`, {
          headers: { 'content-type': 'text/html' },
        }),
    )
    const transport = new FetchWebTransport({
      fetch: fetchImpl as unknown as typeof fetch,
    })
    const result = await transport.request({
      target: 'https://example.com',
      payload: { url: 'https://example.com/long', maxBytes: 800 },
      secrets: new Map(),
    })
    expect(result.content).toContain('…[已按大小截断]')
    expect(
      (result.output as { contentTruncated: boolean }).contentTruncated,
    ).toBe(true)
  })
})

describe('FetchWebTransport hardening', () => {
  it('closes a script block cut open by the download cap', async () => {
    // An unterminated <script> larger than the download cap: the cut lands
    // inside the block, so the virtual closer must kick in.
    const shell =
      '<html><body><main><p>真正的正文在这里。</p></main><script>var env = "' +
      'x'.repeat(2_200_000) +
      '"</script></body></html>'
    const fetchImpl = vi.fn(
      async () =>
        new Response(shell, { headers: { 'content-type': 'text/html' } }),
    )
    const transport = new FetchWebTransport({
      fetch: fetchImpl as unknown as typeof fetch,
    })
    const result = await transport.request({
      target: 'https://cnn.example.com',
      payload: { url: 'https://cnn.example.com/' },
      secrets: new Map(),
    })
    expect(result.content).toContain('真正的正文在这里。')
    expect(result.content).not.toMatch(/x{50}/)
    expect(
      (result.output as { downloadTruncated: boolean }).downloadTruncated,
    ).toBe(true)
  })

  it('hits the cache across different maxBytes requests', async () => {
    const paragraphs = Array.from(
      { length: 120 },
      (_, i) => `<p>第 ${i} 段。</p>`,
    ).join('')
    const fetchImpl = vi.fn(
      async () =>
        new Response(`<main>${paragraphs}</main>`, {
          headers: { 'content-type': 'text/html' },
        }),
    )
    const transport = new FetchWebTransport({
      fetch: fetchImpl as unknown as typeof fetch,
    })
    const first = await transport.request({
      target: 'https://example.com',
      payload: { url: 'https://example.com/doc', maxBytes: 400 },
      secrets: new Map(),
    })
    expect(first.content).toContain('…[已按大小截断]')
    const second = await transport.request({
      target: 'https://example.com',
      // no maxBytes this time — different trim, same cache entry
      payload: { url: 'https://example.com/doc' },
      secrets: new Map(),
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect((second.output as { cached?: boolean }).cached).toBe(true)
    expect(
      (second.output as { contentTruncated?: boolean }).contentTruncated,
    ).toBe(false)
  })

  it('validates every redirect hop against the allowlist', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://www.news.example/front') {
        return new Response('', {
          status: 302,
          headers: { location: 'https://edition.news.example/front' },
        })
      }
      if (url === 'https://edition.news.example/front') {
        return new Response('<main><p>OK</p></main>', {
          headers: { 'content-type': 'text/html' },
        })
      }
      if (url === 'https://www.news.example/trap') {
        return new Response('', {
          status: 301,
          headers: { location: 'https://tracker.example/leak' },
        })
      }
      throw new Error(`unexpected ${url}`)
    })
    const transport = new FetchWebTransport({
      fetch: fetchImpl as unknown as typeof fetch,
      allowedOrigins: [
        'https://www.news.example',
        'https://edition.news.example',
      ],
    })
    const ok = await transport.request({
      target: 'https://www.news.example',
      payload: { url: 'https://www.news.example/front' },
      secrets: new Map(),
    })
    expect(ok.isError).toBe(false)
    expect(ok.content).toContain('OK')
    expect((ok.output as { url: string }).url).toBe(
      'https://edition.news.example/front',
    )
    const leak = await transport.request({
      target: 'https://www.news.example',
      payload: { url: 'https://www.news.example/trap' },
      secrets: new Map(),
    })
    expect(leak.isError).toBe(true)
    expect(leak.content).toContain('outside the allowlisted origins')
  })
})

describe('htmlToText', () => {
  it('drops scripts and styles, keeps block text', () => {
    const text = htmlToText(
      '<style>a{}</style><script>var x=1;</script><p>One</p><div>Two</div><br>Three',
    )
    expect(text).toBe('One\nTwo\nThree')
  })

  it('keeps anchors as Markdown links resolved against the base URL', () => {
    const text = htmlToText(
      '<p><a href="/news/articles/xyz">尼泊尔洪灾</a>死亡人数破千。</p>' +
        '<p><a href="#section">跳转</a></p>' +
        '<p><a href="https://other.example/a">绝对链接</a></p>',
      'https://www.bbc.com/news/world',
    )
    expect(text).toContain(
      '[尼泊尔洪灾](https://www.bbc.com/news/articles/xyz)',
    )
    expect(text).toContain('死亡人数破千。')
    // Fragment-only hrefs keep the label, drop the link.
    expect(text).toContain('跳转')
    expect(text).not.toContain('](#')
    expect(text).toContain('[绝对链接](https://other.example/a)')
  })
})

describe('search origin grants (delegated review)', () => {
  it('searches grant their result origins to the fetch adapter', async () => {
    const grants = new SearchOriginGrants()
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        results: [
          { title: 'A', url: 'https://news.example.org/story/a', content: 'S' },
          { title: 'B', url: 'javascript:alert(1)', content: 'skip' },
        ],
      }),
    )
    const transport = new FetchWebTransport({
      fetch: fetchImpl as unknown as typeof fetch,
      searchBackend: { kind: 'searxng' },
      searchGrants: grants,
    })
    const search = await transport.request({
      target: 'http://127.0.0.1:8888',
      payload: { query: 'q' },
      secrets: new Map(),
    })
    expect(search.isError).toBeUndefined()

    const adapter = new WebFetchToolAdapter({
      allowedOrigins: ['https://static.example.com'],
      searchGrants: grants,
    })
    // The searched origin passes describe; an unknown one still fails.
    expect(() =>
      adapter.describe({
        callId: 'c1',
        toolId: 'web_fetch',
        input: { url: 'https://news.example.org/story/a' },
      }),
    ).not.toThrow()
    expect(() =>
      adapter.describe({
        callId: 'c2',
        toolId: 'web_fetch',
        input: { url: 'https://evil.example.com/x' },
      }),
    ).toThrow(/not allowlisted/)
  })

  it('grants expire after their TTL', async () => {
    const grants = new SearchOriginGrants(20)
    grants.grant(['https://temp.example.com/a'])
    expect(grants.has('https://temp.example.com')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(grants.has('https://temp.example.com')).toBe(false)
  })
})
