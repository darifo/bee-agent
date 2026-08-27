import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MemoryIngestInput, MemoryQuery } from '@bee-agent/knowledge'
import { InMemoryMemoryProvider } from '@bee-agent/knowledge/testing'
import {
  FetchMemoryTransport,
  MemoryTransportError,
  RemoteMemoryProvider,
  createMemoryBridgeTransport,
} from '../src/index.ts'

/**
 * A reference HTTP memory server: routes the documented wire contract onto
 * an in-process provider through the SDK bridge. This pins both ends of the
 * contract — the transport's requests and a compliant server's responses.
 */
function startReferenceServer(): Promise<{
  server: Server
  provider: InMemoryMemoryProvider
  url: string
}> {
  const provider = new InMemoryMemoryProvider()
  const bridge = createMemoryBridgeTransport(provider)
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body =
        chunks.length === 0
          ? undefined
          : JSON.parse(Buffer.concat(chunks).toString())
      const send = (status: number, payload: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(payload))
      }
      const path = request.url ?? ''
      try {
        if (request.method === 'POST' && path === '/memory/ingest') {
          void bridge
            .ingest(body as MemoryIngestInput)
            .then((result) => send(200, result))
          return
        }
        if (request.method === 'POST' && path === '/memory/query') {
          void bridge
            .query(body as MemoryQuery)
            .then((claims) => send(200, { claims }))
          return
        }
        if (request.method === 'POST' && path === '/memory/retract') {
          const input = body as { claimId: string; reason?: string }
          void bridge
            .retract(input.claimId, input.reason)
            .then((claim) => send(200, claim))
          return
        }
        if (request.method === 'GET' && path === '/memory/health') {
          void bridge.health().then((health) => send(200, health))
          return
        }
        if (request.method === 'GET' && path === '/memory/export') {
          void bridge.export().then((exported) => send(200, exported))
          return
        }
        send(404, { message: 'unknown route' })
      } catch (error) {
        send(500, {
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port =
        address !== null && typeof address === 'object' ? address.port : 0
      resolve({ server, provider, url: `http://127.0.0.1:${port}` })
    })
  })
}

describe('FetchMemoryTransport', () => {
  let reference: Awaited<ReturnType<typeof startReferenceServer>>
  let transport: FetchMemoryTransport

  beforeAll(async () => {
    reference = await startReferenceServer()
    transport = new FetchMemoryTransport({ baseUrl: reference.url })
  })

  afterAll(() => {
    reference.server.close()
  })

  it('round-trips ingest, query, retract, and export over HTTP', async () => {
    const recorded = await transport.ingest({
      claims: [
        {
          kind: 'preference',
          statement: 'Prefer jasmine tea',
          subject: { type: 'user' },
          provenance: { streamId: 'thread:t1', sequence: 3 },
        },
      ],
    })
    expect(recorded.claims).toHaveLength(1)

    const found = await transport.query({ text: 'jasmine tea' })
    expect(found).toHaveLength(1)
    expect(found[0]!.statement).toBe('Prefer jasmine tea')

    await transport.retract(found[0]!.id, 'user asked')
    const exported = await transport.export()
    expect(exported.claims[0]!.status).toBe('retracted')

    expect(await transport.health()).toEqual({ status: 'healthy' })
  })

  it('surfaces HTTP failures as MemoryTransportError with the status', async () => {
    const failing = new FetchMemoryTransport({
      baseUrl: `${reference.url}/nope`,
    })
    await expect(failing.health()).rejects.toBeInstanceOf(MemoryTransportError)
    await expect(failing.health()).rejects.toMatchObject({ status: 404 })
  })

  it('fails closed on connection errors with status 0', async () => {
    const dead = new FetchMemoryTransport({
      baseUrl: 'http://127.0.0.1:1',
    })
    await expect(dead.health()).rejects.toMatchObject({ status: 0 })
  })

  it('sits behind the remote provider breaker end-to-end', async () => {
    const provider = new RemoteMemoryProvider({
      transport: new FetchMemoryTransport({ baseUrl: reference.url }),
      failureThreshold: 1,
    })
    const recorded = await provider.ingest({
      claims: [
        {
          kind: 'fact',
          statement: 'Uses HTTPS transport',
          subject: { type: 'project' },
          provenance: { streamId: 'thread:t2', sequence: 1 },
        },
      ],
    })
    expect(recorded.claims).toHaveLength(1)
    expect((await provider.health()).status).toBe('healthy')
  })
})
