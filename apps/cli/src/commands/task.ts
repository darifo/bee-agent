import type { Command } from 'commander'
import { BeeAgentClient } from '@bee-agent/client'
import {
  exitCodeFor,
  printError,
  printEvent,
  printSnapshot,
} from '../format.ts'

const DEFAULT_URL = 'http://127.0.0.1:3000'

export function clientFrom(program: Command): BeeAgentClient {
  const options = program.opts<{ url?: string }>()
  const url = options.url ?? process.env.BEE_AGENT_URL ?? DEFAULT_URL
  return new BeeAgentClient({ baseUrl: url })
}

export async function runCommand(
  action: () => Promise<number | void>,
): Promise<void> {
  try {
    const code = await action()
    if (typeof code === 'number') process.exitCode = code
  } catch (error) {
    printError(error)
    process.exitCode = 1
  }
}

export function registerTaskCommands(program: Command): void {
  const task = program.command('task').description('Manage tasks')

  task
    .command('list')
    .description('List task snapshots, oldest first')
    .option('--json', 'print raw JSON')
    .action(async (options: { json?: boolean }) => {
      await runCommand(async () => {
        const tasks = await clientFrom(program).listTasks()
        if (options.json) {
          console.log(JSON.stringify(tasks, null, 2))
          return
        }
        if (tasks.length === 0) {
          console.log('no tasks')
          return
        }
        for (const snapshot of tasks) {
          const summary =
            snapshot.error !== undefined
              ? `  ${snapshot.error}`
              : snapshot.cancelReason !== undefined
                ? `  ${snapshot.cancelReason}`
                : (snapshot.spec?.input ?? '')
          console.log(
            `${snapshot.taskId}  ${snapshot.state.padEnd(16)} ${summary}`,
          )
        }
      })
    })

  task
    .command('create')
    .description('Create a pending task')
    .requiredOption('-i, --input <text>', 'task input')
    .option('-a, --agent <agentId>', 'agent id', 'agent.mock')
    .option('--json', 'print raw JSON')
    .action(
      async (options: { input: string; agent: string; json?: boolean }) => {
        await runCommand(async () => {
          const api = clientFrom(program)
          const response = await api.createTask({
            input: options.input,
            agentId: options.agent,
            metadata: {},
          })
          if (options.json) {
            console.log(JSON.stringify(response, null, 2))
          } else {
            console.log(response.task.id)
          }
        })
      },
    )

  task
    .command('run')
    .description('Start a task and stream events until it finishes')
    .argument('<taskId>')
    .action(async (taskId: string) => {
      await runCommand(async () => {
        const api = clientFrom(program)
        const started = await api.runTask(taskId)
        console.log(`started (${started.state})`)
        const controller = new AbortController()
        const abort = () => controller.abort()
        process.once('SIGINT', abort)
        let state: string | undefined
        try {
          for await (const event of api.streamEvents(taskId, {
            signal: controller.signal,
          })) {
            state = printEvent(event) ?? state
          }
        } finally {
          process.removeListener('SIGINT', abort)
        }
        if (state === undefined) {
          state = (await api.getTask(taskId)).state
        }
        return exitCodeFor(state)
      })
    })

  task
    .command('get')
    .description('Print the current task snapshot')
    .argument('<taskId>')
    .option('--json', 'print raw JSON')
    .action(async (taskId: string, options: { json?: boolean }) => {
      await runCommand(async () => {
        printSnapshot(
          await clientFrom(program).getTask(taskId),
          options.json === true,
        )
      })
    })

  task
    .command('events')
    .description('List recorded task events')
    .argument('<taskId>')
    .option('--after <sequence>', 'resume after this sequence', '0')
    .option('--json', 'print raw JSON')
    .action(
      async (taskId: string, options: { after: string; json?: boolean }) => {
        await runCommand(async () => {
          const events = await clientFrom(program).listEvents(
            taskId,
            Number(options.after) || 0,
          )
          if (options.json) {
            console.log(JSON.stringify(events, null, 2))
            return
          }
          for (const event of events) printEvent(event)
        })
      },
    )

  task
    .command('cancel')
    .description('Cancel a task')
    .argument('<taskId>')
    .option('-r, --reason <reason>', 'cancel reason')
    .action(async (taskId: string, options: { reason?: string }) => {
      await runCommand(async () => {
        printSnapshot(
          await clientFrom(program).cancelTask(taskId, options.reason),
          false,
        )
      })
    })

  task
    .command('watch')
    .description('Stream task events without starting the task')
    .argument('<taskId>')
    .action(async (taskId: string) => {
      await runCommand(async () => {
        const api = clientFrom(program)
        const controller = new AbortController()
        const abort = () => controller.abort()
        process.once('SIGINT', abort)
        let state: string | undefined
        try {
          for await (const event of api.streamEvents(taskId, {
            signal: controller.signal,
          })) {
            state = printEvent(event) ?? state
          }
        } finally {
          process.removeListener('SIGINT', abort)
        }
        if (state !== undefined) return exitCodeFor(state)
      })
    })
}
