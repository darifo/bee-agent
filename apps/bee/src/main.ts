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
import { CommandToolAdapter } from '@bee-agent/tool-command'
import { PythonToolAdapter } from '@bee-agent/tool-python'
import {
  registerRuntimeChronicleEvents,
  MacOSKeychainSecretBroker,
  PlatformCommandSandbox,
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

const commandExecutables = (process.env.BEE_AGENT_COMMAND_EXECUTABLES ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value !== '')
const commandTool =
  commandExecutables.length === 0
    ? undefined
    : new CommandToolAdapter({
        workspaceRoot: process.env.BEE_AGENT_COMMAND_WORKSPACE ?? process.cwd(),
        allowedExecutables: commandExecutables,
        maxTimeoutMs: envNumber('BEE_AGENT_COMMAND_MAX_TIMEOUT_MS', 30_000),
        maxOutputBytes: envNumber(
          'BEE_AGENT_COMMAND_MAX_OUTPUT_BYTES',
          1_048_576,
        ),
      })

const pythonExecutable = process.env.BEE_AGENT_PYTHON_EXECUTABLE?.trim()
const pythonRuntimeReadPaths = (
  process.env.BEE_AGENT_PYTHON_RUNTIME_READ_PATHS ?? ''
)
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value !== '')
const pythonTool =
  pythonExecutable === undefined || pythonExecutable === ''
    ? undefined
    : new PythonToolAdapter({
        workspaceRoot: process.env.BEE_AGENT_PYTHON_WORKSPACE ?? process.cwd(),
        executable: pythonExecutable,
        runtimeReadPaths: pythonRuntimeReadPaths,
        maxInputBytes: envNumber('BEE_AGENT_PYTHON_MAX_INPUT_BYTES', 1_048_576),
        maxTimeoutMs: envNumber('BEE_AGENT_PYTHON_MAX_TIMEOUT_MS', 30_000),
        maxOutputBytes: envNumber(
          'BEE_AGENT_PYTHON_MAX_OUTPUT_BYTES',
          1_048_576,
        ),
      })

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
  toolAdapters: [commandTool, pythonTool].filter(
    (adapter): adapter is CommandToolAdapter | PythonToolAdapter =>
      adapter !== undefined,
  ),
  sandboxProvider: new PlatformCommandSandbox(),
  ...(process.platform === 'darwin'
    ? { secretBroker: new MacOSKeychainSecretBroker() }
    : {}),
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
