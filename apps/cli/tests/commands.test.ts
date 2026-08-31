import { describe, expect, it } from 'vitest'
import { Command } from 'commander'

/**
 * In-process smoke test of the Phase 6 CLI surface: command groups and
 * names are asserted on a real commander program without spawning a
 * process (the repo forbids child_process outside ExecutionWorld).
 */

async function build(): Promise<Command> {
  const { registerCommands } = await import('../src/main.ts')
  const program = new Command()
  registerCommands(program)
  return program
}

function names(program: Command): string[] {
  return program.commands.map((command) => command.name())
}

describe('phase 6 CLI surface', () => {
  it('exposes doctor, memory, and learning command groups', async () => {
    const program = await build()
    for (const command of [
      'chat',
      'thread',
      'kanban',
      'doctor',
      'memory',
      'learning',
    ]) {
      expect(names(program)).toContain(command)
    }
  })

  it('learning exposes the full governance lifecycle', async () => {
    const program = await build()
    const learning = program.commands.find((c) => c.name() === 'learning')
    const sub = names(learning!)
    for (const command of [
      'run',
      'list',
      'show',
      'experiment',
      'review',
      'trial',
      'promote',
      'reject',
      'rollback',
      'monitor',
    ]) {
      expect(sub).toContain(command)
    }
  })

  it('memory exposes list, forget, and consolidate', async () => {
    const program = await build()
    const memory = program.commands.find((c) => c.name() === 'memory')
    expect(names(memory!)).toEqual(
      expect.arrayContaining(['list', 'forget', 'consolidate']),
    )
  })
})
