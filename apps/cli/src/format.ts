import type { ThreadEvent } from '@bee-agent/thread/protocol'
import type { TurnResult } from '@bee-agent/client'
import { BeeAgentClientError } from '@bee-agent/client'

/** Renders thread events and turn results as plain text. */

/** Prints one streamed thread event; returns the turn status it implies. */
export function printThreadEvent(event: ThreadEvent): string | undefined {
  switch (event.event) {
    case 'turn.started':
      process.stdout.write('bee> ')
      return undefined
    case 'item.delta':
      process.stdout.write(event.delta)
      return undefined
    case 'item.completed':
      if (event.item.type === 'tool_call') {
        process.stdout.write(`\n  [tool ${event.item.payload.toolId}]`)
      } else if (event.item.type === 'approval') {
        process.stdout.write(
          `\n  [approval "${event.item.payload.title}": ${event.item.payload.status}]`,
        )
      }
      return undefined
    case 'turn.completed':
      process.stdout.write('\n')
      return 'completed'
    case 'turn.failed':
      process.stdout.write(`\n[turn failed] ${event.error}\n`)
      return 'failed'
    case 'turn.cancelled':
      process.stdout.write('\n[turn cancelled]\n')
      return 'cancelled'
    case 'agent.checkpoint':
    case 'item.started':
    case 'item.failed':
    case 'thread.created':
      return undefined
  }
}

/** Prints a terminal turn result. */
export function printTurnResult(result: TurnResult): void {
  switch (result.status) {
    case 'completed':
      console.log(`bee> ${result.output}`)
      return
    case 'failed':
      console.log(`[turn failed] ${result.error}`)
      return
    case 'cancelled':
      console.log('[turn cancelled]')
      return
    case 'suspended':
      console.log(`[waiting] approval "${result.approval.title}" required`)
  }
}

export function printError(error: unknown): void {
  if (error instanceof BeeAgentClientError) {
    console.error(
      `error [${error.code}] (HTTP ${error.status}): ${error.message}`,
    )
    return
  }
  console.error(error instanceof Error ? error.message : String(error))
}
