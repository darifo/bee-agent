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

const server = await buildServer(
  dialect === 'postgres'
    ? { postgresUrl, logger: true }
    : {
        sqliteFilename:
          process.env.BEE_AGENT_STORAGE_SQLITE_FILENAME ?? 'bee-agent.sqlite',
        logger: true,
      },
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
