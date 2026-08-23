import type { Command } from 'commander'
import { printError } from '../format.js'
import { clientFrom } from './task.js'

async function runCommand(action: () => Promise<number | void>): Promise<void> {
  try {
    const code = await action()
    if (typeof code === 'number') process.exitCode = code
  } catch (error) {
    printError(error)
    process.exitCode = 1
  }
}

export function registerApprovalCommands(program: Command): void {
  const approval = program.command('approval').description('Manage approvals')

  approval
    .command('list')
    .description('List pending approval requests')
    .option('-t, --task <taskId>', 'scope to one task')
    .option('--json', 'print raw JSON')
    .action(async (options: { task?: string; json?: boolean }) => {
      await runCommand(async () => {
        const approvals = await clientFrom(program).listPendingApprovals(
          options.task,
        )
        if (options.json) {
          console.log(JSON.stringify(approvals, null, 2))
          return
        }
        if (approvals.length === 0) {
          console.log('no pending approvals')
          return
        }
        for (const request of approvals) {
          console.log(`${request.id}  task ${request.taskId}`)
          console.log(`  tool  ${request.toolCall.toolId}`)
          console.log(`  risk  ${request.risk}  ${request.reason}`)
        }
      })
    })

  approval
    .command('decide')
    .description('Decide a pending approval request')
    .argument('<requestId>')
    .option('--approve', 'approve the request')
    .option('--deny', 'deny the request')
    .option('-r, --reason <reason>', 'decision reason')
    .action(
      async (
        requestId: string,
        options: { approve?: boolean; deny?: boolean; reason?: string },
      ) => {
        await runCommand(async () => {
          if (options.approve === options.deny) {
            throw new Error('pass exactly one of --approve or --deny')
          }
          const decision = await clientFrom(program).resolveApproval(
            requestId,
            options.approve === true,
            options.reason,
          )
          console.log(
            `${decision.approved ? 'approved' : 'denied'} ${requestId}`,
          )
        })
      },
    )
}
