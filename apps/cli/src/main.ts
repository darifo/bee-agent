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

export function registerCommands(program: Command): void {
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

  const kanban = program
    .command('kanban')
    .description('Manage the kanban board')

  kanban
    .command('create')
    .description('Create a task')
    .requiredOption('-t, --title <title>', 'task title')
    .option('--priority <priority>', 'priority')
    .option('--label <label...>', 'labels')
    .option('--json', 'print raw JSON')
    .action(
      async (options: {
        title: string
        priority?: string
        label?: string[]
        json?: boolean
      }) => {
        try {
          const task = await clientFrom(program).createTask({
            title: options.title,
            ...(options.priority !== undefined
              ? { priority: options.priority }
              : {}),
            ...(options.label !== undefined ? { labels: options.label } : {}),
          })
          if (options.json) {
            console.log(JSON.stringify(task, null, 2))
          } else {
            console.log(`${task.id}\t${task.status}\t${task.title}`)
          }
        } catch (error) {
          printError(error)
          process.exitCode = 1
        }
      },
    )

  kanban
    .command('list')
    .description('List tasks')
    .option('--status <status>', 'filter by status')
    .option('--json', 'print raw JSON')
    .action(async (options: { status?: string; json?: boolean }) => {
      try {
        const tasks = await clientFrom(program).listTasks({
          ...(options.status !== undefined ? { status: options.status } : {}),
        })
        if (options.json) {
          console.log(JSON.stringify(tasks, null, 2))
        } else {
          for (const task of tasks) {
            console.log(
              `${task.id}\t${task.status}\t${task.priority}\t${task.title}`,
            )
          }
        }
      } catch (error) {
        printError(error)
        process.exitCode = 1
      }
    })

  kanban
    .command('show')
    .description('Show a task')
    .argument('<id>', 'task id')
    .option('--json', 'print raw JSON')
    .action(async (id: string, options: { json?: boolean }) => {
      try {
        const task = await clientFrom(program).getTask(id)
        if (options.json) {
          console.log(JSON.stringify(task, null, 2))
        } else {
          console.log(`${task.status}\t${task.title}`)
        }
      } catch (error) {
        printError(error)
        process.exitCode = 1
      }
    })

  kanban
    .command('update')
    .description('Update a task')
    .argument('<id>', 'task id')
    .option('--title <title>', 'new title')
    .option('--priority <priority>', 'new priority')
    .option('--json', 'print raw JSON')
    .action(
      async (
        id: string,
        options: { title?: string; priority?: string; json?: boolean },
      ) => {
        try {
          const task = await clientFrom(program).updateTask(id, {
            ...(options.title !== undefined ? { title: options.title } : {}),
            ...(options.priority !== undefined
              ? { priority: options.priority }
              : {}),
          })
          if (options.json) {
            console.log(JSON.stringify(task, null, 2))
          } else {
            console.log(`${task.id}\t${task.status}\t${task.title}`)
          }
        } catch (error) {
          printError(error)
          process.exitCode = 1
        }
      },
    )

  kanban
    .command('block')
    .description('Block a task')
    .argument('<id>', 'task id')
    .option('--reason <reason>', 'block reason')
    .option('--json', 'print raw JSON')
    .action(
      async (id: string, options: { reason?: string; json?: boolean }) => {
        try {
          const task = await clientFrom(program).blockTask(id, options.reason)
          if (options.json) {
            console.log(JSON.stringify(task, null, 2))
          } else {
            console.log(`${task.id}\t${task.status}`)
          }
        } catch (error) {
          printError(error)
          process.exitCode = 1
        }
      },
    )

  kanban
    .command('comment')
    .description('Comment on a task')
    .argument('<id>', 'task id')
    .argument('<body>', 'comment body')
    .option('--author <author>', 'comment author')
    .option('--json', 'print raw JSON')
    .action(
      async (
        id: string,
        body: string,
        options: { author?: string; json?: boolean },
      ) => {
        try {
          const task = await clientFrom(program).commentTask(
            id,
            body,
            options.author,
          )
          if (options.json) {
            console.log(JSON.stringify(task, null, 2))
          } else {
            console.log(`${task.id}\t${task.comments.length} comment(s)`)
          }
        } catch (error) {
          printError(error)
          process.exitCode = 1
        }
      },
    )

  kanban
    .command('complete')
    .description('Complete a task')
    .argument('<id>', 'task id')
    .option('--json', 'print raw JSON')
    .action(async (id: string, options: { json?: boolean }) => {
      try {
        const task = await clientFrom(program).completeTask(id)
        if (options.json) {
          console.log(JSON.stringify(task, null, 2))
        } else {
          console.log(`${task.id}\t${task.status}`)
        }
      } catch (error) {
        printError(error)
        process.exitCode = 1
      }
    })

  kanban
    .command('cancel')
    .description('Cancel a task')
    .argument('<id>', 'task id')
    .option('--json', 'print raw JSON')
    .action(async (id: string, options: { json?: boolean }) => {
      try {
        const task = await clientFrom(program).cancelTask(id)
        if (options.json) {
          console.log(JSON.stringify(task, null, 2))
        } else {
          console.log(`${task.id}\t${task.status}`)
        }
      } catch (error) {
        printError(error)
        process.exitCode = 1
      }
    })

  // ---------------------------------------------------------------------------
  // doctor / memory / learning (Phase 6)
  // ---------------------------------------------------------------------------

  program
    .command('doctor')
    .description('One-call health overview of the Bee Host')
    .option('--json', 'print raw JSON')
    .action(async (options: { json?: boolean }) => {
      try {
        const d = await clientFrom(program).diagnostics()
        if (options.json) {
          console.log(JSON.stringify(d, null, 2))
          return
        }
        console.log(`status: ${d.status}`)
        console.log(
          `structure: ${d.structure.activeVersion ?? 'none'}${
            d.structure.restartRequired ? ' (restart required)' : ''
          }`,
        )
        const issues =
          (d.structure.doctor as { issues?: unknown[] }).issues ?? []
        console.log(`kernel issues: ${issues.length}`)
        if (d.memory.enabled) {
          console.log(
            `memory: ${d.memory.health.status} (claims ${d.memory.claims.active} active / ${d.memory.claims.total} total)`,
          )
        } else {
          console.log('memory: disabled')
        }
        console.log(
          d.world.enabled
            ? `world: v${d.world.version} (${d.world.entities} entities, ${d.world.relations} relations)`
            : 'world: disabled',
        )
        console.log(
          d.scheduler.enabled
            ? `scheduler: ${d.scheduler.triggers} triggers`
            : 'scheduler: disabled',
        )
        if (d.learning.enabled) {
          console.log(`learning: ${JSON.stringify(d.learning.byStatus)}`)
        } else {
          console.log('learning: disabled')
        }
        console.log(`threads: ${d.threads.streams}`)
      } catch (error) {
        printError(error)
        process.exitCode = 1
      }
    })

  const memory = program
    .command('memory')
    .description('Govern what Bee remembers')

  memory
    .command('list')
    .description('List memory claims')
    .option('--status <status>', 'active | superseded | retracted')
    .option('--kind <kind>', 'preference | fact | correction | procedure')
    .option('--json', 'print raw JSON')
    .action(
      async (options: { status?: string; kind?: string; json?: boolean }) => {
        try {
          const claims = await clientFrom(program).listMemoryClaims({
            ...(options.status === undefined
              ? {}
              : { status: options.status as 'active' }),
            ...(options.kind === undefined
              ? {}
              : { kind: options.kind as 'preference' }),
          })
          if (options.json) {
            console.log(JSON.stringify(claims, null, 2))
            return
          }
          for (const claim of claims) {
            console.log(
              `${claim.id.slice(0, 8)}\t${claim.status}\t${claim.kind}\t${claim.statement.slice(0, 72)}`,
            )
          }
        } catch (error) {
          printError(error)
          process.exitCode = 1
        }
      },
    )

  memory
    .command('forget')
    .description('Retract (forget) a memory claim')
    .argument('<claimId>', 'claim id')
    .option('--reason <reason>', 'why it is forgotten')
    .action(async (claimId: string, options: { reason?: string }) => {
      try {
        const claim = await clientFrom(program).forgetMemoryClaim(
          claimId,
          options.reason,
        )
        console.log(`${claim.id.slice(0, 8)}\t${claim.status}`)
      } catch (error) {
        printError(error)
        process.exitCode = 1
      }
    })

  memory
    .command('consolidate')
    .description('Merge duplicate memory claims')
    .action(async () => {
      try {
        const report = await clientFrom(program).consolidateMemory()
        console.log(JSON.stringify(report))
      } catch (error) {
        printError(error)
        process.exitCode = 1
      }
    })

  const learning = program
    .command('learning')
    .description('Govern background learning proposals')

  learning
    .command('run')
    .description('Run the slow loop once')
    .action(async () => {
      try {
        const report = await clientFrom(program).runLearningLoop()
        console.log(JSON.stringify(report, null, 2))
      } catch (error) {
        printError(error)
        process.exitCode = 1
      }
    })

  learning
    .command('list')
    .description('List improvement proposals')
    .option('--status <status>', 'draft | testing | review | trial | ...')
    .option('--origin <origin>', 'loop | user')
    .action(async (options: { status?: string; origin?: string }) => {
      try {
        const proposals = await clientFrom(program).listLearningProposals({
          ...(options.status === undefined ? {} : { status: options.status }),
          ...(options.origin === undefined
            ? {}
            : { origin: options.origin as 'loop' }),
        })
        for (const p of proposals) {
          console.log(
            `${p.id.slice(0, 8)}\t${p.status}\tL${p.autonomyLevel}\t${p.targetKey}`,
          )
        }
      } catch (error) {
        printError(error)
        process.exitCode = 1
      }
    })

  learning
    .command('show')
    .description('Show one proposal in full')
    .argument('<id>', 'proposal id')
    .action(async (id: string) => {
      try {
        const p = await clientFrom(program).getLearningProposal(id)
        console.log(JSON.stringify(p, null, 2))
      } catch (error) {
        printError(error)
        process.exitCode = 1
      }
    })

  learning
    .command('experiment')
    .description('Run the isolated experiment for a proposal')
    .argument('<id>', 'proposal id')
    .action(async (id: string) => {
      try {
        const report = await clientFrom(program).runLearningExperiment(id)
        console.log(JSON.stringify(report, null, 2))
      } catch (error) {
        printError(error)
        process.exitCode = 1
      }
    })

  async function transitionCommand(
    id: string,
    to: string,
    version: string,
    reason: string | undefined,
  ): Promise<void> {
    try {
      const p = await clientFrom(program).transitionLearningProposal({
        proposalId: id,
        to: to as 'review',
        expectedVersion: Number(version),
        ...(reason === undefined ? {} : { reason }),
      })
      console.log(`${p.id.slice(0, 8)}\t${p.status}\tv${p.version}`)
    } catch (error) {
      printError(error)
      process.exitCode = 1
    }
  }

  for (const [cmd, to, hint] of [
    ['review', 'review', 'move a draft to review'],
    ['trial', 'trial', 'start a personal trial'],
    ['promote', 'promoted', 'approve: activate the change'],
    ['reject', 'rejected', 'archive with a reason'],
    ['rollback', 'rolled-back', 'retract an activation'],
  ] as const) {
    learning
      .command(cmd)
      .description(hint)
      .argument('<id>', 'proposal id')
      .argument('<version>', 'expected version (optimistic concurrency)')
      .option('--reason <reason>', 'why')
      .action(
        async (id: string, version: string, options: { reason?: string }) => {
          await transitionCommand(id, to, version, options.reason)
        },
      )
  }

  learning
    .command('monitor')
    .description('Run the drift monitor once')
    .action(async () => {
      try {
        const report = await clientFrom(program).monitorLearningDrift()
        console.log(JSON.stringify(report, null, 2))
      } catch (error) {
        printError(error)
        process.exitCode = 1
      }
    })
}

program.parseAsync().catch((error: unknown) => {
  printError(error)
  process.exitCode = 1
})
