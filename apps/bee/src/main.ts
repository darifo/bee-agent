import { ChronicleSchemaRegistry } from '@bee-agent/knowledge'
import { SQLiteChronicleStore } from '@bee-agent/plugin-storage-sqlite'
import { OpenAIChatRuntime } from '@bee-agent/model-providers'
import { registerThreadChronicleEvents } from '@bee-agent/thread'
import type { AgentLoopToolSlot } from '@bee-agent/runtime'
import { buildBeeServer } from './app.js'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3000

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

const host = process.env.BEE_AGENT_HOST ?? DEFAULT_HOST
const port = envNumber('BEE_AGENT_PORT', DEFAULT_PORT)

// The model is configured through the v1 LLMRuntime; keys arrive via
// environment only and are never persisted.
const apiKey = process.env.BEE_AGENT_MODEL_API_KEY ?? ''
const model = process.env.BEE_AGENT_MODEL_NAME ?? ''
if (apiKey === '' || model === '') {
  console.error(
    'BEE_AGENT_MODEL_API_KEY and BEE_AGENT_MODEL_NAME are required to start the host',
  )
  process.exit(1)
}
const llm = new OpenAIChatRuntime({
  apiKey,
  model,
  ...(process.env.BEE_AGENT_MODEL_BASE_URL !== undefined
    ? { baseUrl: process.env.BEE_AGENT_MODEL_BASE_URL }
    : {}),
})

// A placeholder tool seam until real tools land (P1-13 minimal form): tool
// calls resolve to an echo result so a bare conversation can run end to end.
const tools: AgentLoopToolSlot = {
  async execute({ call }) {
    return {
      kind: 'result',
      output: call.input,
      content: JSON.stringify(call.input),
    }
  },
}

const registry = new ChronicleSchemaRegistry()
registerThreadChronicleEvents(registry)
const store = new SQLiteChronicleStore({
  registry,
  filename: process.env.BEE_AGENT_STORAGE_SQLITE_FILENAME ?? 'bee-agent.sqlite',
})

const server = await buildBeeServer({ store, llm, tools })
try {
  await server.app.listen({ host, port })
} catch (error) {
  server.app.log.error(error, 'failed to start the HTTP server')
  process.exitCode = 1
  await server.app.close()
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.app.close().finally(() => process.exit(0))
  })
}
