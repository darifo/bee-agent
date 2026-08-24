import {
  CommandAgent,
  CommandAgentConfigSchema,
} from '@bee-agent/agent-adapters'
import { OpenAIChatAgent, OpenAIEmbedder } from '@bee-agent/model-providers'
import { McpServerConfigSchema } from '@bee-agent/plugin-tool-mcp'
import type { McpServerConfig } from '@bee-agent/plugin-tool-mcp'
import type { Agent, Embedder } from '@bee-agent/runtime'
import { buildServer } from './app.js'

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

// One storage dialect per instance (ADR 0004): exactly one of the two
// dialect-specific options is ever handed to the composition root.
const dialect = process.env.BEE_AGENT_STORAGE_DIALECT ?? 'sqlite'
if (dialect !== 'sqlite' && dialect !== 'postgres') {
  console.error(
    `BEE_AGENT_STORAGE_DIALECT must be "sqlite" or "postgres", got "${dialect}"`,
  )
  process.exit(1)
}

const postgresUrl = process.env.BEE_AGENT_STORAGE_POSTGRES_URL
if (dialect === 'postgres' && (postgresUrl ?? '') === '') {
  console.error(
    'BEE_AGENT_STORAGE_POSTGRES_URL is required when BEE_AGENT_STORAGE_DIALECT=postgres',
  )
  process.exit(1)
}

// Optional Vector Store plugin; pgvector rides on the PostgreSQL dialect.
const vectorStore = process.env.BEE_AGENT_VECTOR_STORE
if (vectorStore !== undefined && vectorStore !== 'pgvector') {
  console.error(
    `BEE_AGENT_VECTOR_STORE must be "pgvector" when set, got "${vectorStore}"`,
  )
  process.exit(1)
}

// Real model providers speak the OpenAI-compatible HTTP surface (ADR 0013);
// keys arrive via environment only and are never persisted.
const modelProvider = process.env.BEE_AGENT_MODEL_PROVIDER
if (modelProvider !== undefined && modelProvider !== 'openai-compatible') {
  console.error(
    `BEE_AGENT_MODEL_PROVIDER must be "openai-compatible" when set, got "${modelProvider}"`,
  )
  process.exit(1)
}
let defaultAgent: Agent | undefined
if (modelProvider === 'openai-compatible') {
  const apiKey = process.env.BEE_AGENT_MODEL_API_KEY ?? ''
  const modelName = process.env.BEE_AGENT_MODEL_NAME ?? ''
  if (apiKey === '' || modelName === '') {
    console.error(
      'BEE_AGENT_MODEL_API_KEY and BEE_AGENT_MODEL_NAME are required when BEE_AGENT_MODEL_PROVIDER=openai-compatible',
    )
    process.exit(1)
  }
  defaultAgent = new OpenAIChatAgent({
    apiKey,
    model: modelName,
    ...(process.env.BEE_AGENT_MODEL_BASE_URL !== undefined
      ? { baseUrl: process.env.BEE_AGENT_MODEL_BASE_URL }
      : {}),
    ...(process.env.BEE_AGENT_MODEL_SYSTEM_PROMPT !== undefined
      ? { systemPrompt: process.env.BEE_AGENT_MODEL_SYSTEM_PROMPT }
      : {}),
  })
}

const embeddingProvider = process.env.BEE_AGENT_EMBEDDING_PROVIDER
if (
  embeddingProvider !== undefined &&
  embeddingProvider !== 'openai-compatible'
) {
  console.error(
    `BEE_AGENT_EMBEDDING_PROVIDER must be "openai-compatible" when set, got "${embeddingProvider}"`,
  )
  process.exit(1)
}
let embedder: Embedder | undefined
if (embeddingProvider === 'openai-compatible') {
  const apiKey = process.env.BEE_AGENT_EMBEDDING_API_KEY ?? ''
  const modelName = process.env.BEE_AGENT_EMBEDDING_MODEL ?? ''
  const dimensions = Number(process.env.BEE_AGENT_EMBEDDING_DIMENSIONS ?? '')
  if (
    apiKey === '' ||
    modelName === '' ||
    !Number.isInteger(dimensions) ||
    dimensions < 1
  ) {
    console.error(
      'BEE_AGENT_EMBEDDING_API_KEY, BEE_AGENT_EMBEDDING_MODEL, and a positive integer BEE_AGENT_EMBEDDING_DIMENSIONS are required when BEE_AGENT_EMBEDDING_PROVIDER=openai-compatible',
    )
    process.exit(1)
  }
  embedder = new OpenAIEmbedder({
    apiKey,
    model: modelName,
    dimensions,
    ...(process.env.BEE_AGENT_EMBEDDING_BASE_URL !== undefined
      ? { baseUrl: process.env.BEE_AGENT_EMBEDDING_BASE_URL }
      : {}),
  })
}

// MCP tool servers (ADR 0014): a JSON array of stdio server configs, e.g.
// BEE_AGENT_MCP='[{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}]'
let mcpServers: McpServerConfig[] | undefined
const mcpRaw = process.env.BEE_AGENT_MCP
if (mcpRaw !== undefined && mcpRaw.trim() !== '') {
  const parsed: unknown = JSON.parse(mcpRaw)
  mcpServers = McpServerConfigSchema.array().parse(parsed)
}

// Python tool (ADR 0015): opt-in only — it runs arbitrary code in one-shot
// child processes, which is crash isolation, not a security sandbox.
const pythonEnabled = ['1', 'true'].includes(
  (process.env.BEE_AGENT_ENABLE_PYTHON ?? '').toLowerCase(),
)

// External command agents (ADR 0016): a JSON array of CommandAgent configs,
// e.g. BEE_AGENT_COMMAND_AGENTS='[{"id":"agent.upper","command":"tr","args":["a-z","A-Z"],"inputVia":"stdin"}]'
let commandAgents: CommandAgent[] | undefined
const commandAgentsRaw = process.env.BEE_AGENT_COMMAND_AGENTS
if (commandAgentsRaw !== undefined && commandAgentsRaw.trim() !== '') {
  const parsed: unknown = JSON.parse(commandAgentsRaw)
  const configs = CommandAgentConfigSchema.array().parse(parsed)
  commandAgents = configs.map((config) => new CommandAgent(config))
}

const server = await buildServer({
  ...(dialect === 'postgres'
    ? { postgresUrl }
    : {
        sqliteFilename:
          process.env.BEE_AGENT_STORAGE_SQLITE_FILENAME ?? 'bee-agent.sqlite',
      }),
  ...(vectorStore === 'pgvector' ? { vectorStore } : {}),
  ...(defaultAgent !== undefined ? { defaultAgent } : {}),
  ...(embedder !== undefined ? { embedder } : {}),
  ...(mcpServers !== undefined ? { mcpServers } : {}),
  ...(pythonEnabled ? { pythonTool: true } : {}),
  ...(commandAgents !== undefined ? { agents: commandAgents } : {}),
  logger: true,
})
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
