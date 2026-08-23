#!/usr/bin/env node
import { Command } from 'commander'
import { registerApprovalCommands } from './commands/approval.js'
import { registerTaskCommands } from './commands/task.js'

const program = new Command()

program
  .name('bee')
  .description('Command line client for the Bee Agent server')
  .version('0.1.0')
  .option(
    '-u, --url <url>',
    'Bee Agent server base URL (env BEE_AGENT_URL)',
    process.env.BEE_AGENT_URL ?? 'http://127.0.0.1:3000',
  )

registerTaskCommands(program)
registerApprovalCommands(program)

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
