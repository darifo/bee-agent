import { randomBytes } from 'node:crypto'
import {
  ChronicleSchemaRegistry,
  registerStructureChronicleEvents,
} from '@bee-agent/knowledge'
import {
  SQLiteChronicleStore,
  SQLiteKanbanStore,
} from '@bee-agent/storage-sqlite'
import { OpenAIChatRuntime } from '@bee-agent/model-providers'
import { registerKanbanChronicleEvents } from '@bee-agent/kanban'
import { registerThreadChronicleEvents } from '@bee-agent/thread'
import {
  registerRuntimeChronicleEvents,
  type ToolExecutor,
} from '@bee-agent/runtime'
import { buildBeeServer, unsafeListenReason } from './app.ts'

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

// Remote exposure fails closed (architecture §16.4): binding a non-loopback
// address requires an explicit session token, so a stray `BEE_AGENT_HOST` or
// a plugin cannot silently open the host to the network.
const sessionToken = process.env.BEE_AGENT_SESSION_TOKEN
const listenRefusal = unsafeListenReason(host, sessionToken)
if (listenRefusal !== undefined) {
  console.error(listenRefusal)
  process.exit(1)
}
const effectiveToken = sessionToken ?? randomBytes(24).toString('hex')

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
const toolExecutor: ToolExecutor = {
  describe(call) {
    return {
      capability: `tool:${call.toolId}`,
      requirements: {
        readPaths: [],
        writePaths: [],
        networkTargets: [],
        commands: [],
        secretRefs: [],
      },
      expectedEffects: ['Return the supplied input without host side effects'],
      verification: ['Output equals input'],
    }
  },
  async execute({ call }) {
    return {
      output: call.input,
      content: JSON.stringify(call.input),
      verification: ['Output equals input'],
    }
  },
}

const registry = new ChronicleSchemaRegistry()
registerStructureChronicleEvents(registry)
registerThreadChronicleEvents(registry)
registerRuntimeChronicleEvents(registry)
registerKanbanChronicleEvents(registry)
const filename =
  process.env.BEE_AGENT_STORAGE_SQLITE_FILENAME ?? 'bee-agent.sqlite'
const store = new SQLiteChronicleStore({ registry, filename })
const kanban = new SQLiteKanbanStore({ registry, filename })
// Recover the board from the durable log before serving.
await kanban.rebuild()

const server = await buildBeeServer({
  store,
  kanban,
  llm,
  toolExecutor,
  sessionToken: effectiveToken,
})
server.app.log.info(
  { sessionToken: effectiveToken },
  'one-time session token for the local Web client',
)
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
