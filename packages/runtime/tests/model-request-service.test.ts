import { describe, expect, it } from 'vitest'
import { registerContextManifestChronicleEvents } from '@bee-agent/context'
import { ChronicleSchemaRegistry } from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import {
  ModelRequestService,
  modelRequestStreamId,
  rebuildModelRequest,
  registerModelRequestChronicleEvents,
} from '../src/model-request-service.ts'
import { createFakeLlmRuntime } from '../src/testing.ts'

function store(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerContextManifestChronicleEvents(registry)
  registerModelRequestChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

describe('ModelRequestService', () => {
  it('persists the call lifecycle and exactly rebuilds model-visible input', async () => {
    const chronicle = store()
    const llm = createFakeLlmRuntime({
      script: [{ type: 'respond', deltas: ['done'] }],
    })
    const service = new ModelRequestService({
      store: chronicle,
      llm,
      promptVersion: 'system@2',
      structureVersion: 'sha256:structure',
      tokenBudget: 8192,
    })
    const bundle = {
      messages: [
        { role: 'system' as const, content: 'Be exact.' },
        { role: 'user' as const, content: 'Calculate.' },
      ],
      tools: [
        {
          id: 'calculator',
          description: 'Calculates',
          inputSchema: { type: 'object' },
        },
      ],
      decisionSchema: { type: 'object', required: ['answer'] },
    }
    const call = await service.generate({
      threadId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      stepIndex: 2,
      attempt: 1,
      bundle,
    })
    for await (const event of call.events) {
      // Drain the provider stream before observing its settled result.
      void event
    }
    await call.result

    const events = []
    for await (const event of chronicle.readStream(
      modelRequestStreamId(call.requestId),
    )) {
      events.push(event)
    }
    expect(events.map((event) => event.eventType)).toEqual([
      'context.manifest',
      'model.requested',
      'model.completed',
    ])
    expect(call.manifest.sections).toHaveLength(4)
    expect((events[1]?.payload as { stepIndex: number }).stepIndex).toBe(2)

    const rebuilt = await rebuildModelRequest(chronicle, call.requestId)
    expect(rebuilt.bundle).toEqual(bundle)
  })

  it('records a failed terminal event', async () => {
    const chronicle = store()
    const llm = createFakeLlmRuntime({
      script: [
        {
          type: 'fail',
          error: { message: 'provider down', retryability: 'fatal' },
        },
      ],
    })
    const service = new ModelRequestService({
      store: chronicle,
      llm,
      promptVersion: 'system@1',
      structureVersion: 'sha256:structure',
    })
    const call = await service.generate({
      threadId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      stepIndex: 0,
      attempt: 0,
      bundle: { messages: [], tools: [] },
    })
    for await (const event of call.events) {
      // Drain.
      void event
    }
    await expect(call.result).rejects.toThrow('provider down')

    const kinds: string[] = []
    for await (const event of chronicle.readStream(
      modelRequestStreamId(call.requestId),
    )) {
      kinds.push(event.eventType)
    }
    expect(kinds.at(-1)).toBe('model.failed')
  })
})
