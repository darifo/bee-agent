import { describe, expect, it } from 'vitest'
import type { SuiteAPI, TestAPI, ExpectStatic } from 'vitest'
import {
  ChronicleSchemaRegistry,
  MEMORY_STREAM_ID,
  MemoryProviderUnavailableError,
  registerMemoryChronicleEvents,
} from '@bee-agent/knowledge'
import {
  InMemoryMemoryProvider,
  MemoryChronicleStore,
  defineMemoryProviderContractSuite,
} from '@bee-agent/knowledge/testing'
import {
  RemoteMemoryProvider,
  createMemoryBridgeTransport,
} from '../src/index.ts'
import type { MemoryBridgeTransport } from '../src/index.ts'

// The remote stack satisfies the full provider contract: the breaker must
// not alter memory semantics while the transport is healthy.
defineMemoryProviderContractSuite(
  {
    describe: describe as SuiteAPI,
    it: it as TestAPI,
    expect: expect as ExpectStatic,
  },
  {
    name: 'RemoteMemoryProvider over the SDK bridge (contract)',
    async create() {
      return {
        provider: new RemoteMemoryProvider({
          transport: createMemoryBridgeTransport(new InMemoryMemoryProvider()),
        }),
      }
    },
    destroy() {},
  },
)

/** Wraps a transport, failing the next `state.remaining` calls of any method. */
function flakyTransport(
  inner: MemoryBridgeTransport,
  state: { remaining: number; calls: number },
): MemoryBridgeTransport {
  function wrapOp<A extends unknown[], R>(
    op: (...args: A) => Promise<R>,
  ): (...args: A) => Promise<R> {
    return async (...args: A) => {
      state.calls += 1
      if (state.remaining > 0) {
        state.remaining -= 1
        throw new Error('transport down')
      }
      return op(...args)
    }
  }
  return {
    ingest: wrapOp(inner.ingest.bind(inner)),
    query: wrapOp(inner.query.bind(inner)),
    buildContext: wrapOp(inner.buildContext.bind(inner)),
    getRepresentation: wrapOp(inner.getRepresentation.bind(inner)),
    derive: wrapOp(inner.derive.bind(inner)),
    consolidate: wrapOp(inner.consolidate.bind(inner)),
    retract: wrapOp(inner.retract.bind(inner)),
    export: wrapOp(inner.export.bind(inner)),
    health: wrapOp(inner.health.bind(inner)),
  }
}

function createLocalStore(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerMemoryChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

async function readTransitions(store: MemoryChronicleStore): Promise<string[]> {
  const transitions: string[] = []
  for await (const event of store.readStream(MEMORY_STREAM_ID)) {
    transitions.push(
      `${(event.payload as { from: string }).from}->${(event.payload as { to: string }).to}`,
    )
  }
  return transitions
}

describe('RemoteMemoryProvider breaker', () => {
  it('degrades, opens, fails fast, and recovers with durable transitions', async () => {
    const store = createLocalStore()
    const state = { remaining: 2, calls: 0 }
    const inner = createMemoryBridgeTransport(new InMemoryMemoryProvider())
    const provider = new RemoteMemoryProvider({
      transport: flakyTransport(inner, state),
      store,
      failureThreshold: 2,
    })

    // First failure: the transport error propagates; the breaker reports its
    // degraded view without another transport call.
    await expect(provider.query({ text: 'anything' })).rejects.toThrow(
      'transport down',
    )
    expect(state.calls).toBe(1)
    expect((await provider.health()).status).toBe('degraded')
    expect(state.calls).toBe(1)

    // Second failure opens the circuit.
    await expect(provider.query({ text: 'anything' })).rejects.toThrow(
      'transport down',
    )

    // Circuit open: calls fail fast without touching the transport.
    const callsBeforeFastFail = state.calls
    await expect(provider.query({ text: 'anything' })).rejects.toBeInstanceOf(
      MemoryProviderUnavailableError,
    )
    expect(state.calls).toBe(callsBeforeFastFail)

    // The recovery probe closes the circuit once the transport answers, and
    // normal calls succeed again.
    expect((await provider.health()).status).toBe('healthy')
    await expect(provider.query({ text: 'anything' })).resolves.toEqual([])

    // Every transition is a durable memory.health.changed fact, in order.
    await provider.settled()
    expect(await readTransitions(store)).toEqual([
      'healthy->degraded',
      'degraded->unavailable',
      'unavailable->healthy',
    ])
    await store.close()
  })

  it('keeps breaker state without a local store', async () => {
    const state = { remaining: 1, calls: 0 }
    const inner = createMemoryBridgeTransport(new InMemoryMemoryProvider())
    const provider = new RemoteMemoryProvider({
      transport: flakyTransport(inner, state),
      failureThreshold: 1,
    })

    await expect(provider.query({ text: 'x' })).rejects.toThrow(
      'transport down',
    )
    await expect(provider.query({ text: 'x' })).rejects.toBeInstanceOf(
      MemoryProviderUnavailableError,
    )
    expect((await provider.health()).status).toBe('healthy')
  })

  it('rejects invalid thresholds', () => {
    expect(
      () =>
        new RemoteMemoryProvider({
          transport: createMemoryBridgeTransport(new InMemoryMemoryProvider()),
          failureThreshold: 0,
        }),
    ).toThrow(/failureThreshold/)
  })
})
