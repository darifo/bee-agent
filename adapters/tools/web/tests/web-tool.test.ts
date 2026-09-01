import { describe, expect, it, vi } from 'vitest'
import {
  FetchWebTransport,
  WEB_FETCH_TOOL_ID,
  WEB_SEARCH_TOOL_ID,
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
    expect(result.isError).toBeUndefined()
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
    expect(page.isError).toBeUndefined()
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
