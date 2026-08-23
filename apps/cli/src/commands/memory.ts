import type { Command } from 'commander'
import { clientFrom, runCommand } from './task.js'

function parseLimit(value: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--limit must be a positive integer, got "${value}"`)
  }
  return parsed
}

export function registerMemoryCommands(program: Command): void {
  const memory = program
    .command('memory')
    .description('Manage workspace memory (requires a Vector Store server)')

  memory
    .command('remember')
    .description('Store a document as embedded memory chunks')
    .requiredOption('-w, --workspace <id>', 'workspace id')
    .requiredOption('-t, --text <content>', 'document content')
    .option('--json', 'print raw JSON')
    .action(
      async (options: { workspace: string; text: string; json?: boolean }) => {
        await runCommand(async () => {
          const { document, chunks } = await clientFrom(
            program,
          ).rememberDocument({
            workspaceId: options.workspace,
            content: options.text,
          })
          if (options.json) {
            console.log(JSON.stringify({ document, chunks }, null, 2))
            return
          }
          console.log(`document ${document.id} → ${chunks.length} chunk(s)`)
          for (const chunk of chunks) {
            console.log(`  [${chunk.ordinal}] ${chunk.content.slice(0, 72)}`)
          }
        })
      },
    )

  memory
    .command('recall')
    .description('Recall the nearest memory chunks for a query')
    .requiredOption('-w, --workspace <id>', 'workspace id')
    .requiredOption('-q, --query <text>', 'query text')
    .option('-n, --limit <n>', 'max results (default 10)', parseLimit)
    .option('--json', 'print raw JSON')
    .action(
      async (options: {
        workspace: string
        query: string
        limit?: number
        json?: boolean
      }) => {
        await runCommand(async () => {
          const { results } = await clientFrom(program).recallMemory({
            workspaceId: options.workspace,
            text: options.query,
            ...(options.limit !== undefined ? { limit: options.limit } : {}),
          })
          if (options.json) {
            console.log(JSON.stringify(results, null, 2))
            return
          }
          if (results.length === 0) {
            console.log('no memories')
            return
          }
          for (const { chunk, score } of results) {
            const scoreText = score.toFixed(4)
            console.log(
              `[${scoreText}] ${chunk.content.slice(0, 72)}  (${chunk.id})`,
            )
          }
        })
      },
    )

  memory
    .command('forget <chunkId>')
    .description('Drop one memory chunk from its workspace')
    .requiredOption('-w, --workspace <id>', 'workspace id')
    .action(async (chunkId: string, options: { workspace: string }) => {
      await runCommand(async () => {
        await clientFrom(program).forgetMemoryChunk(chunkId, options.workspace)
        console.log(`forgot chunk ${chunkId}`)
      })
    })
}
