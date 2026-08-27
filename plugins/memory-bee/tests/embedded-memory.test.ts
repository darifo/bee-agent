import { describe, expect, it } from 'vitest'
import type { SuiteAPI, TestAPI, ExpectStatic } from 'vitest'
import {
  ChronicleSchemaRegistry,
  registerMemoryChronicleEvents,
} from '@bee-agent/knowledge'
import {
  MemoryChronicleStore,
  defineMemoryProviderContractSuite,
} from '@bee-agent/knowledge/testing'
import {
  EmbeddedMemoryProvider,
  deriveClaimCandidates,
  tokenizeMemoryText,
} from '../src/index.ts'

const harness = {
  describe: describe as SuiteAPI,
  it: it as TestAPI,
  expect: expect as ExpectStatic,
}

interface Subject {
  readonly provider: EmbeddedMemoryProvider
  readonly store: MemoryChronicleStore
}

defineMemoryProviderContractSuite(harness, {
  name: 'EmbeddedMemoryProvider (contract)',
  async create(): Promise<Subject> {
    const registry = new ChronicleSchemaRegistry()
    registerMemoryChronicleEvents(registry)
    const store = new MemoryChronicleStore(registry)
    const provider = new EmbeddedMemoryProvider({ store })
    await provider.rebuild()
    return { provider, store }
  },
  async destroy(subject: Subject) {
    await subject.store.close()
  },
})

function provenance(sequence: number) {
  return {
    streamId: 'thread:t1',
    sequence,
    threadId: 't1',
    turnId: 'v1',
    itemId: `i${sequence}`,
  }
}

describe('EmbeddedMemoryProvider', () => {
  it('rebuilds its projection from the memory stream after restart', async () => {
    const registry = new ChronicleSchemaRegistry()
    registerMemoryChronicleEvents(registry)
    const store = new MemoryChronicleStore(registry)
    const first = new EmbeddedMemoryProvider({ store })
    const recorded = await first.ingest({
      claims: [
        {
          kind: 'preference',
          statement: 'Prefer espresso over filter coffee',
          subject: { type: 'user' },
          provenance: provenance(1),
        },
      ],
    })
    await first.retract(recorded.claims[0]!.id)

    const restarted = new EmbeddedMemoryProvider({ store })
    await restarted.rebuild()
    const exported = await restarted.export()
    expect(exported.claims).toHaveLength(1)
    expect(exported.claims[0]!.status).toBe('retracted')
    expect(await restarted.query({ text: 'espresso' })).toEqual([])
    await store.close()
  })

  it('ranks lexical matches over non-matches with CJK bigram support', async () => {
    const registry = new ChronicleSchemaRegistry()
    registerMemoryChronicleEvents(registry)
    const store = new MemoryChronicleStore(registry)
    const provider = new EmbeddedMemoryProvider({ store })
    await provider.ingest({
      claims: [
        {
          kind: 'fact',
          statement: 'The build tool is pnpm',
          subject: { type: 'project' },
          provenance: provenance(1),
        },
        {
          kind: 'preference',
          statement: '以后请一直用中文回复',
          subject: { type: 'user' },
          provenance: provenance(2),
        },
      ],
    })

    const english = await provider.query({ text: 'build tool pnpm' })
    expect(english).toHaveLength(1)
    expect(english[0]!.statement).toContain('pnpm')

    const chinese = await provider.query({ text: '中文回复' })
    expect(chinese).toHaveLength(1)
    expect(chinese[0]!.statement).toContain('中文')
    await store.close()
  })

  it('derives corrections that supersede the latest recorded preference', async () => {
    const registry = new ChronicleSchemaRegistry()
    registerMemoryChronicleEvents(registry)
    const store = new MemoryChronicleStore(registry)
    const provider = new EmbeddedMemoryProvider({ store })
    const original = await provider.ingest({
      claims: [
        {
          kind: 'preference',
          statement: 'Always answer in English',
          subject: { type: 'user' },
          provenance: provenance(1),
          recordedAt: '2026-01-01T00:00:00Z',
        },
      ],
    })

    const derived = await provider.derive({
      threadId: 't1',
      turnId: 'v2',
      messages: [
        {
          role: 'user',
          content: 'Actually, always answer in German.',
          provenance: provenance(2),
        },
      ],
    })
    expect(derived.claims).toHaveLength(1)
    expect(derived.claims[0]!.kind).toBe('correction')
    expect(derived.claims[0]!.supersedes).toEqual([original.claims[0]!.id])

    await provider.ingest({ claims: derived.claims })
    expect(await provider.query({ text: 'english' })).toEqual([])
    expect(await provider.query({ text: 'german' })).toHaveLength(1)
    await store.close()
  })

  it('consolidate is idempotent across runs', async () => {
    const registry = new ChronicleSchemaRegistry()
    registerMemoryChronicleEvents(registry)
    const store = new MemoryChronicleStore(registry)
    const provider = new EmbeddedMemoryProvider({ store })
    for (const sequence of [1, 2]) {
      await provider.ingest({
        claims: [
          {
            kind: 'preference',
            statement: 'Prefer linen shirts',
            subject: { type: 'user' },
            provenance: provenance(sequence),
          },
        ],
      })
    }

    const first = await provider.consolidate()
    expect(first.merged).toHaveLength(1)
    const second = await provider.consolidate()
    expect(second.merged).toEqual([])
    await store.close()
  })

  it('ignores ordinary chatter during derivation', () => {
    const result = deriveClaimCandidates(
      [
        {
          role: 'user',
          content: 'What is the capital of France? Also, how tall is it?',
          provenance: provenance(1),
        },
        {
          role: 'assistant',
          content: 'The capital is Paris.',
          provenance: provenance(2),
        },
      ],
      { activeClaims: [] },
    )
    expect(result.claims).toEqual([])
  })
})

describe('tokenizeMemoryText', () => {
  it('drops English stopwords and emits CJK bigrams', () => {
    expect(tokenizeMemoryText('The editor theme')).toEqual(['editor', 'theme'])
    expect(tokenizeMemoryText('中文')).toEqual(['中', '文', '中文'])
  })
})

describe('long-horizon recall (fake clock, §7.2 Phase 4 gate)', () => {
  it('recalls the corrected preference weeks later and expires time-boxed facts', async () => {
    const registry = new ChronicleSchemaRegistry()
    registerMemoryChronicleEvents(registry)
    const store = new MemoryChronicleStore(registry)
    // A mutable fake clock: day N is 2026-01-01 plus N days.
    let day = 0
    const clock = () =>
      new Date(Date.parse('2026-01-01T00:00:00Z') + day * 86_400_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, '.000Z')
    const provider = new EmbeddedMemoryProvider({ store, now: clock })

    // Day 1: the user states a durable preference.
    const day1 = await provider.derive({
      threadId: 't-long',
      turnId: 'v1',
      messages: [
        {
          role: 'user',
          content: 'From now on, always answer in Basque.',
          provenance: {
            streamId: 'thread:t-long',
            sequence: 3,
            threadId: 't-long',
            turnId: 'v1',
          },
        },
      ],
    })
    await provider.ingest({ claims: day1.claims })
    // Day 1: a time-boxed fact valid for two weeks only.
    await provider.ingest({
      claims: [
        {
          kind: 'fact',
          statement: 'The staging API token is currant-juice-42',
          subject: { type: 'project', id: 'staging' },
          provenance: {
            streamId: 'thread:t-long',
            sequence: 5,
            threadId: 't-long',
            turnId: 'v1',
          },
          validTime: {
            from: clock(),
            to: new Date(Date.parse(clock()) + 14 * 86_400_000)
              .toISOString()
              .replace(/\.\d{3}Z$/, '.000Z'),
          },
        },
      ],
    })

    // Day 10: the user corrects the language preference.
    day = 10
    const day10 = await provider.derive({
      threadId: 't-long',
      turnId: 'v2',
      messages: [
        {
          role: 'user',
          content: 'Actually, always answer in Welsh.',
          provenance: {
            streamId: 'thread:t-long',
            sequence: 12,
            threadId: 't-long',
            turnId: 'v2',
          },
        },
      ],
    })
    await provider.ingest({ claims: day10.claims })

    // Day 30: recall reflects the correction and honors valid time.
    day = 30
    const recalled = await provider.query({ text: 'answer language' })
    expect(recalled).toHaveLength(1)
    expect(recalled[0]!.kind).toBe('correction')
    expect(recalled[0]!.statement).toContain('Welsh')

    const expired = await provider.query({ text: 'staging token currant' })
    expect(expired).toEqual([])

    // The full history survives in the export with truthful statuses: the
    // expired fact stays 'active' (valid time is a query-time filter).
    const exported = await provider.export()
    expect(exported.claims.map((claim) => claim.status).sort()).toEqual([
      'active',
      'active',
      'superseded',
    ])
    await store.close()
  })
})
