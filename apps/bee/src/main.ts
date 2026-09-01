import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ChronicleSchemaRegistry,
  ExecutionResourceProjector,
  ThreadToolProjector,
  registerMemoryChronicleEvents,
  registerStructureChronicleEvents,
  registerWorldChronicleEvents,
} from '@bee-agent/knowledge'
import {
  SQLiteChronicleStore,
  SQLiteKanbanStore,
} from '@bee-agent/storage-sqlite'
import { OpenAIChatRuntime } from '@bee-agent/model-providers'
import { registerKanbanChronicleEvents } from '@bee-agent/kanban'
import { registerLearningChronicleEvents } from '@bee-agent/learning'
import { registerThreadChronicleEvents } from '@bee-agent/thread'
import { CommandToolAdapter } from '@bee-agent/tool-command'
import {
  McpServerManifestSchema,
  createMcpToolAdapters,
} from '@bee-agent/tool-mcp'
import { PythonToolAdapter } from '@bee-agent/tool-python'
import {
  FetchWebTransport,
  WebFetchToolAdapter,
  WebSearchToolAdapter,
} from '@bee-agent/tool-web'
import { EmbeddedMemoryProvider } from '@bee-agent/memory-bee'
import {
  FetchMemoryTransport,
  RemoteMemoryProvider,
} from '@bee-agent/memory-remote'
import {
  FileEffectiveStructureSource,
  MemoryGoalPlanStore,
  registerRuntimeChronicleEvents,
  MacOSKeychainSecretBroker,
  LinuxSecretServiceBroker,
  PlatformCommandSandbox,
  AllowlistedNetworkSandbox,
  RoutingSandboxProvider,
} from '@bee-agent/runtime'
import { TimeService } from '@bee-agent/runtime'
import { buildBeeServer, unsafeListenReason } from './app.ts'
import { resolveBeeDataDir } from './data-dir.ts'

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

const mcpManifestInput = process.env.BEE_AGENT_MCP_MANIFESTS
const mcpTools =
  mcpManifestInput === undefined || mcpManifestInput.trim() === ''
    ? []
    : McpServerManifestSchema.array()
        .parse(JSON.parse(mcpManifestInput))
        .flatMap(createMcpToolAdapters)

// Web retrieval (ADR 0023 network actions): the host reviews the origins,
// the model never picks one. fetch origins come from the allowlist env; the
// search engine origin comes from the configured backend. Both run through
// the AllowlistedNetworkSandbox via one host-injected transport.
const webFetchOrigins = (process.env.BEE_AGENT_WEB_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value !== '')
const searxngUrl = process.env.BEE_AGENT_SEARCH_SEARXNG_URL?.trim()
const tavilyUrl = process.env.BEE_AGENT_SEARCH_TAVILY_URL?.trim()
const tavilyKey = process.env.BEE_AGENT_SEARCH_TAVILY_API_KEY?.trim()
const searchBackend =
  searxngUrl !== undefined && searxngUrl !== ''
    ? ({ kind: 'searxng' } as const)
    : tavilyUrl !== undefined && tavilyUrl !== '' && tavilyKey !== undefined
      ? ({ kind: 'tavily', apiKey: tavilyKey } as const)
      : undefined
if (
  (searxngUrl !== undefined && searxngUrl !== '') ||
  (tavilyUrl !== undefined && tavilyUrl !== '')
) {
  if (searchBackend === undefined) {
    console.error(
      'BEE_AGENT_SEARCH_TAVILY_URL also needs BEE_AGENT_SEARCH_TAVILY_API_KEY',
    )
    process.exit(1)
  }
}
const webFetchTool =
  webFetchOrigins.length === 0
    ? undefined
    : new WebFetchToolAdapter({ allowedOrigins: webFetchOrigins })
const webSearchTool =
  searchBackend === undefined
    ? undefined
    : new WebSearchToolAdapter({
        engineOrigin:
          searchBackend.kind === 'searxng' ? searxngUrl! : tavilyUrl!,
      })
const webNetworkTargets = [
  ...(webFetchTool?.allowedOrigins ?? []),
  ...(webSearchTool ? [webSearchTool.engineOrigin] : []),
]
const commandSandbox = new PlatformCommandSandbox()
// One stable network sandbox instance: RoutingSandboxProvider pairs
// snapshot/diff calls by provider identity, so the selector must never
// hand out fresh instances per action.
const networkSandbox = new AllowlistedNetworkSandbox(
  webNetworkTargets,
  new FetchWebTransport({ searchBackend }),
)
const sandboxProvider =
  webNetworkTargets.length === 0
    ? commandSandbox
    : new RoutingSandboxProvider((request) =>
        request.requirements.networkTargets.length > 0
          ? networkSandbox
          : commandSandbox,
      )

const registry = new ChronicleSchemaRegistry()
registerStructureChronicleEvents(registry)
registerThreadChronicleEvents(registry)
registerRuntimeChronicleEvents(registry)
registerKanbanChronicleEvents(registry)
registerLearningChronicleEvents(registry)
registerMemoryChronicleEvents(registry)
registerWorldChronicleEvents(registry)

// The unified personal data directory backs every durable artifact by
// default; an explicit filename still wins (absolute, or relative to cwd).
const dataDir = resolveBeeDataDir({
  env: process.env,
  home: homedir(),
  platform: process.platform,
})
await mkdir(dataDir, { recursive: true })
const filename =
  process.env.BEE_AGENT_STORAGE_SQLITE_FILENAME ??
  join(dataDir, 'bee-agent.sqlite')
const store = new SQLiteChronicleStore({ registry, filename })
const kanban = new SQLiteKanbanStore({ registry, filename })
// Recover the board from the durable log before serving.
await kanban.rebuild()

// Personal memory: an explicit remote endpoint (WF4-C HTTP transport with a
// circuit breaker and durable health events) replaces the embedded provider;
// otherwise the embedded provider projects the durable `memory` stream.
const memoryRemoteUrl = process.env.BEE_AGENT_MEMORY_REMOTE_URL?.trim()
const memoryRemoteToken = process.env.BEE_AGENT_MEMORY_REMOTE_TOKEN?.trim()
let memory
if (memoryRemoteUrl === undefined || memoryRemoteUrl === '') {
  const embedded = new EmbeddedMemoryProvider({ store })
  await embedded.rebuild()
  memory = embedded
} else {
  memory = new RemoteMemoryProvider({
    transport: new FetchMemoryTransport({
      baseUrl: memoryRemoteUrl,
      ...(memoryRemoteToken === undefined ? {} : { token: memoryRemoteToken }),
    }),
    store,
  })
}

// Optional watched desired-state file; reload failures retain the active
// generation and surface through GET /structure.
// Accurate time: local clock + HTTP Date-header calibration, UTC+8 by
// default. Injected into every model request and exposed as time_now.
const timeSources = (process.env.BEE_AGENT_TIME_SOURCES ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value !== '')
const time = new TimeService({
  ...(process.env.BEE_AGENT_TIMEZONE?.trim() !== undefined &&
  process.env.BEE_AGENT_TIMEZONE?.trim() !== ''
    ? { timezone: process.env.BEE_AGENT_TIMEZONE!.trim() }
    : {}),
  ...(timeSources.length === 0 ? {} : { networkSources: timeSources }),
})

const structureFile = process.env.BEE_AGENT_STRUCTURE_FILE?.trim()
const configSource =
  structureFile === undefined || structureFile === ''
    ? undefined
    : new FileEffectiveStructureSource(structureFile)

const server = await buildBeeServer({
  store,
  kanban,
  llm,
  memory,
  time,
  goalPlanStore: new MemoryGoalPlanStore(),
  worldProjectors: [
    new ThreadToolProjector(),
    new ExecutionResourceProjector(),
  ],
  scheduler: true,
  learning: true,
  ...(configSource === undefined ? {} : { configSource }),
  toolAdapters: [
    ...[commandTool, pythonTool, webFetchTool, webSearchTool].filter(
      (adapter) => adapter !== undefined,
    ),
    ...mcpTools,
  ],
  sandboxProvider,
  ...(process.platform === 'darwin'
    ? { secretBroker: new MacOSKeychainSecretBroker() }
    : process.platform === 'linux'
      ? { secretBroker: new LinuxSecretServiceBroker() }
      : {}),
  sessionToken: effectiveToken,
})
server.app.log.info(
  { sessionToken: effectiveToken },
  'one-time session token for the local Web client',
)
// The environment is read once at process start; a later .env edit needs a
// restart. The fingerprint (last four chars, same form providers use in
// errors) makes "which key is this Host actually using" visible.
server.app.log.info(
  { model, apiKeyFingerprint: `…${apiKey.slice(-4)}` },
  'model provider configured (env is loaded at start; restart to pick up .env edits)',
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
