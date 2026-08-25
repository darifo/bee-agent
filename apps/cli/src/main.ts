#!/usr/bin/env node
import { createInterface } from 'node:readline'
import type { Interface } from 'node:readline'
import { Command } from 'commander'
import { BeeAgentClient } from '@bee-agent/client'
import type { BeeAgentClient as BeeAgentClientType } from '@bee-agent/client'
import { runTurnToCompletion } from './chat.ts'
import { printError, printTurnResult } from './format.ts'

const DEFAULT_URL = 'http://127.0.0.1:3000'

function clientFrom(program: Command): BeeAgentClientType {
  const options = program.opts<{ url?: string; token?: string }>()
  const url = options.url ?? process.env.BEE_AGENT_URL ?? DEFAULT_URL
  const token = options.token ?? process.env.BEE_AGENT_SESSION_TOKEN
  return new BeeAgentClient({
    baseUrl: url,
    ...(token !== undefined && token !== '' ? { sessionToken: token } : {}),
  })
}

function ask(rl: Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve))
}

async function chat(api: BeeAgentClientType, threadId: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (;;) {
      const line = await ask(rl, 'you> ')
      const input = line.trim()
      if (input === '') continue
      if (input === '/exit' || input === '/quit') break
      const result = await runTurnToCompletion(
        api,
        threadId,
        input,
        async (approval) => {
          const answer = await ask(
            rl,
            `approval "${approval.title}" — approve? [y/N] `,
          )
          return answer.trim().toLowerCase() === 'y' ? 'approved' : 'rejected'
        },
      )
      printTurnResult(result)
    }
  } finally {
    rl.close()
  }
}

const program = new Command()

program
  .name('bee')
  .description('Command line client for the Personal Bee Host')
  .version('0.1.0')
  .option(
    '-u, --url <url>',
    'host base URL (env BEE_AGENT_URL)',
    process.env.BEE_AGENT_URL ?? DEFAULT_URL,
  )
  .option(
    '--token <token>',
    'one-time session token (env BEE_AGENT_SESSION_TOKEN)',
  )

program
  .command('chat')
  .description('Start an interactive conversation with Bee')
  .option('-t, --title <title>', 'thread title', 'CLI conversation')
  .action(async (options: { title: string }) => {
    try {
      const api = clientFrom(program)
      const thread = await api.createThread({ title: options.title })
      console.log(`thread ${thread.id} — type a message, /exit to quit`)
      await chat(api, thread.id)
    } catch (error) {
      printError(error)
      process.exitCode = 1
    }
  })

program
  .command('thread')
  .description('Manage threads')
  .command('create')
  .description('Create a new thread')
  .option('-t, --title <title>', 'thread title', 'New thread')
  .option('--json', 'print raw JSON')
  .action(async (options: { title: string; json?: boolean }) => {
    try {
      const thread = await clientFrom(program).createThread({
        title: options.title,
      })
      if (options.json) {
        console.log(JSON.stringify(thread, null, 2))
      } else {
        console.log(thread.id)
      }
    } catch (error) {
      printError(error)
      process.exitCode = 1
    }
  })

program.parseAsync().catch((error: unknown) => {
  printError(error)
  process.exitCode = 1
})
