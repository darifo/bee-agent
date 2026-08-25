import { describe, expect, it } from 'vitest'
import { ModelProviderError } from '../src/index.ts'
import { OpenAIEmbedder } from '../src/index.ts'

function fakeFetch(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
}

describe('OpenAIEmbedder', () => {
  it('declares its space and posts inputs for embeddings', async () => {
    const requests: { url: string; init: RequestInit }[] = []
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push({ url: url.toString(), init: init ?? {} })
      return new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
          model: 'text-embedding-3-small',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const embedder = new OpenAIEmbedder({
      apiKey: 'sk-test',
      model: 'text-embedding-3-small',
      dimensions: 3,
      fetch: fetchImpl,
    })

    expect(embedder.space).toEqual({
      id: 'text-embedding-3-small',
      model: 'text-embedding-3-small',
      dimensions: 3,
      metric: 'cosine',
    })
    expect(await embedder.embed(['hello'])).toEqual([[0.1, 0.2, 0.3]])
    expect(requests[0]?.url).toBe('https://api.openai.com/v1/embeddings')
    const headers = requests[0]?.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test')
    expect(requests[0]?.init.body).toBe(
      JSON.stringify({ model: 'text-embedding-3-small', input: ['hello'] }),
    )
  })

  it('restores provider order from the index field', async () => {
    const embedder = new OpenAIEmbedder({
      apiKey: 'sk-test',
      model: 'm',
      dimensions: 2,
      fetch: fakeFetch({
        data: [
          { index: 1, embedding: [0.4, 0.5] },
          { index: 0, embedding: [0.1, 0.2] },
        ],
      }),
    })
    expect(await embedder.embed(['a', 'b'])).toEqual([
      [0.1, 0.2],
      [0.4, 0.5],
    ])
  })

  it('returns nothing for empty input batches', async () => {
    const embedder = new OpenAIEmbedder({
      apiKey: 'sk-test',
      model: 'm',
      dimensions: 2,
      fetch: fakeFetch({ data: [] }),
    })
    expect(await embedder.embed([])).toEqual([])
  })

  it('rejects dimension drift against the declared space', async () => {
    const embedder = new OpenAIEmbedder({
      apiKey: 'sk-test',
      model: 'm',
      dimensions: 3,
      fetch: fakeFetch({ data: [{ index: 0, embedding: [0.1, 0.2] }] }),
    })
    await expect(embedder.embed(['x'])).rejects.toThrow(/space "m" declares 3/)
  })

  it('surfaces provider failures', async () => {
    const embedder = new OpenAIEmbedder({
      apiKey: 'sk-test',
      model: 'm',
      dimensions: 2,
      fetch: fakeFetch({ error: { message: 'quota exceeded' } }, 429),
    })
    const error = (await embedder
      .embed(['x'])
      .catch((reason: unknown) => reason)) as ModelProviderError
    expect(error).toBeInstanceOf(ModelProviderError)
    expect(error.status).toBe(429)
    expect(error.message).toMatch(/quota exceeded/)
  })
})
