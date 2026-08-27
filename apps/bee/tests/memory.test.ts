import { describe, expect, it } from 'vitest'
import {
  ChronicleSchemaRegistry,
  registerMemoryChronicleEvents,
  registerStructureChronicleEvents,
} from '@bee-agent/knowledge'
import { MemoryChronicleStore } from '@bee-agent/knowledge/testing'
import { registerThreadChronicleEvents } from '@bee-agent/thread'
import { registerRuntimeChronicleEvents } from '@bee-agent/runtime'
import { registerKanbanChronicleEvents } from '@bee-agent/kanban'
import { createMemoryKanbanStore } from '@bee-agent/kanban/testing'
import { EmbeddedMemoryProvider } from '@bee-agent/memory-bee'
import { createFakeLlmRuntime } from '@bee-agent/runtime/testing'
import type { FakeLlmRuntime } from '@bee-agent/runtime/testing'
import { buildBeeServer } from '../src/index.ts'
import type { BeeServer } from '../src/index.ts'

function createRegistryStore(): MemoryChronicleStore {
  const registry = new ChronicleSchemaRegistry()
  registerStructureChronicleEvents(registry)
  registerThreadChronicleEvents(registry)
  registerRuntimeChronicleEvents(registry)
  registerMemoryChronicleEvents(registry)
  return new MemoryChronicleStore(registry)
}

interface MemoryServer {
  readonly server: BeeServer
  readonly llm: FakeLlmRuntime
  readonly baseUrl: string
}

async function withMemoryServer(
  script: Parameters<typeof createFakeLlmRuntime>[0]['script'],
  fn: (subject: MemoryServer) => Promise<void>,
): Promise<void> {
  const store = createRegistryStore()
  const llm = createFakeLlmRuntime({ script })
  const server = await buildBeeServer({
    store,
    kanban: createMemoryKanbanStore(
      (() => {
        const registry = new ChronicleSchemaRegistry()
        registerKanbanChronicleEvents(registry)
        return registry
      })(),
    ),
    llm,
    memory: new EmbeddedMemoryProvider({ store }),
    logger: false,
  })
  await server.app.listen({ host: '127.0.0.1', port: 0 })
  await server.app.ready()
  try {
    const address = server.app.server.address()
    const port =
      address !== null && typeof address === 'object' ? address.port : 0
    await fn({ server, llm, baseUrl: `http://127.0.0.1:${port}` })
  } finally {
    await server.app.close()
  }
}

async function runTurn(
  baseUrl: string,
  threadId: string,
  input: string,
): Promise<{ status: string; output?: string }> {
  const response = await fetch(`${baseUrl}/threads/${threadId}/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as { status: string; output?: string }
}

async function createThread(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/threads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'memory test' }),
  })
  expect(response.status).toBe(201)
  const body = (await response.json()) as { id: string }
  return body.id
}

interface ClaimDto {
  readonly id: string
  readonly kind: string
  readonly statement: string
  readonly status: string
}

describe('host memory integration', () => {
  it('derives preferences after a turn, recalls them on the next turn, and supports retraction', async () => {
    await withMemoryServer(
      [
        { type: 'respond', deltas: ['Understood.'] },
        { type: 'respond', deltas: ['Portuguese, per your preference.'] },
      ],
      async ({ server, llm, baseUrl }) => {
        // Turn 1 states a durable preference; the near-line worker
        // derives and records a claim before the response returns.
        const threadId = await createThread(baseUrl)
        const first = await runTurn(
          baseUrl,
          threadId,
          'From now on, always answer in Portuguese.',
        )
        expect(first.status).toBe('completed')

        const claimsResponse = await fetch(`${baseUrl}/memory/claims`)
        const { claims } = (await claimsResponse.json()) as {
          claims: ClaimDto[]
        }
        expect(claims).toHaveLength(1)
        const claim = claims[0]!
        expect(claim.kind).toBe('preference')
        expect(claim.statement).toContain('Portuguese')
        expect(claim.status).toBe('active')

        // Turn 2 recalls the recorded preference into the model bundle.
        const second = await runTurn(
          baseUrl,
          threadId,
          'Which language do you answer in?',
        )
        expect(second.status).toBe('completed')
        const recalled = llm.calls[1]!.bundle.messages.find(
          (message) =>
            message.role === 'system' &&
            message.content.includes('Recalled memory'),
        )
        expect(recalled?.content).toContain('Portuguese')

        // The claim is user-governable: retract hides it from active view.
        const retractResponse = await fetch(
          `${baseUrl}/memory/claims/${claim.id}/retract`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reason: 'no longer wanted' }),
          },
        )
        expect(retractResponse.status).toBe(200)
        const activeResponse = await fetch(
          `${baseUrl}/memory/claims?status=active`,
        )
        const { claims: active } = (await activeResponse.json()) as {
          claims: ClaimDto[]
        }
        expect(active).toHaveLength(0)
        const exportResponse = await fetch(`${baseUrl}/memory/export`)
        const exported = (await exportResponse.json()) as {
          claims: ClaimDto[]
        }
        expect(
          exported.claims.find((entry) => entry.id === claim.id)?.status,
        ).toBe('retracted')

        // A restarted provider over the same store recovers the memory.
        const restarted = new EmbeddedMemoryProvider({ store: server.store })
        await restarted.rebuild()
        const afterRestart = await restarted.export()
        expect(
          afterRestart.claims.find((entry) => entry.id === claim.id)?.status,
        ).toBe('retracted')
      },
    )
  })
})
