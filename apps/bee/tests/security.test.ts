import { describe, expect, it } from 'vitest'
import { ChronicleSchemaRegistry } from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import { registerThreadChronicleEvents } from '@bee-agent/thread'
import { createFakeLlmRuntime } from '@bee-agent/runtime/testing'
import type { AgentLoopToolSlot } from '@bee-agent/runtime'
import {
  buildBeeServer,
  isLoopbackHost,
  loopbackOrigins,
  unsafeListenReason,
} from '../src/index.js'
import type { BeeServer } from '../src/index.js'

function createRegistryStore(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerThreadChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

const noopTools: AgentLoopToolSlot = {
  async execute({ call }) {
    return { kind: 'result', output: call.input, content: 'ok' }
  },
}

async function build(options: {
  sessionToken?: string
  corsOrigin?: boolean | string[]
}): Promise<BeeServer> {
  const llm = createFakeLlmRuntime({ script: [] })
  return buildBeeServer({
    store: createRegistryStore(),
    llm,
    tools: noopTools,
    logger: false,
    ...options,
  })
}

describe('loopback and CORS defaults', () => {
  it('treats only loopback hosts as safe to bind', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('192.168.1.10')).toBe(false)
  })

  it('allows only loopback origins, never arbitrary ones', () => {
    expect(loopbackOrigins('http://127.0.0.1:5173')).toBe(true)
    expect(loopbackOrigins('http://localhost:5173')).toBe(true)
    expect(loopbackOrigins('http://evil.example.com')).toBe(false)
    expect(loopbackOrigins(undefined)).toBe(false)
  })

  it('does not reflect arbitrary origins over CORS', async () => {
    const server = await build({})
    const evil = await server.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://evil.example.com' },
    })
    expect(evil.headers['access-control-allow-origin']).toBeUndefined()

    const local = await server.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://127.0.0.1:5173' },
    })
    expect(local.headers['access-control-allow-origin']).toBe(
      'http://127.0.0.1:5173',
    )
    await server.app.close()
  })

  it('still honours an explicit corsOrigin override', async () => {
    const server = await build({ corsOrigin: ['http://app.example.com'] })
    const allowed = await server.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://app.example.com' },
    })
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'http://app.example.com',
    )
    const denied = await server.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://other.example.com' },
    })
    expect(denied.headers['access-control-allow-origin']).toBeUndefined()
    await server.app.close()
  })
})

describe('listen guard', () => {
  it('refuses a non-loopback host without a session token', () => {
    expect(unsafeListenReason('0.0.0.0', undefined)).toMatch(/non-loopback/)
    expect(unsafeListenReason('0.0.0.0', '')).toMatch(/non-loopback/)
  })

  it('permits loopback binding and token-authenticated remote binding', () => {
    expect(unsafeListenReason('127.0.0.1', undefined)).toBeUndefined()
    expect(unsafeListenReason('0.0.0.0', 'token-123')).toBeUndefined()
  })
})

describe('session token', () => {
  it('rejects requests without the token and exempts /health', async () => {
    const server = await build({ sessionToken: 'secret-token' })

    const health = await server.app.inject({ method: 'GET', url: '/health' })
    expect(health.statusCode).toBe(200)

    const missing = await server.app.inject({
      method: 'POST',
      url: '/threads',
      payload: {},
    })
    expect(missing.statusCode).toBe(401)

    const wrong = await server.app.inject({
      method: 'POST',
      url: '/threads',
      headers: { authorization: 'Bearer wrong' },
      payload: {},
    })
    expect(wrong.statusCode).toBe(401)

    const valid = await server.app.inject({
      method: 'POST',
      url: '/threads',
      headers: { authorization: 'Bearer secret-token' },
      payload: { title: 'authenticated' },
    })
    expect(valid.statusCode).toBe(201)
    await server.app.close()
  })

  it('allows all requests when no token is configured', async () => {
    const server = await build({})
    const response = await server.app.inject({
      method: 'POST',
      url: '/threads',
      payload: {},
    })
    expect(response.statusCode).toBe(201)
    await server.app.close()
  })
})
