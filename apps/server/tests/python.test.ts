import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { MockAgent } from '@bee-agent/runtime'
import { buildServer } from '../src/index.ts'

// The suite needs a python3 interpreter on PATH; it skips otherwise.
function hasPython(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('python tool opt-in', () => {
  it('stays out of the default tool set', async () => {
    const server = await buildServer({
      sqliteFilename: ':memory:',
      logger: false,
    })
    try {
      expect(server.runtime.tools.has('tools.python')).toBe(false)
    } finally {
      await server.app.close()
    }
  })
})

describe.skipIf(!hasPython())('server with the python tool enabled', () => {
  it('executes python through the runtime pipeline when opted in', async () => {
    const server = await buildServer({
      sqliteFilename: ':memory:',
      logger: false,
      pythonTool: true,
    })
    try {
      expect(server.runtime.tools.has('tools.python')).toBe(true)
      expect(server.runtime.tools.has('tools.calculator')).toBe(true)

      server.runtime.registerAgent(
        new MockAgent({
          id: 'agent.python-test',
          script: [
            {
              kind: 'tool',
              toolId: 'tools.python',
              input: {
                code: 'import json; print(json.dumps({"answer": args["x"] ** 100}))',
                args: { x: 2 },
              },
            },
          ],
        }),
      )
      const spec = await server.runtime.createTask({
        input: 'compute 2**100 in python',
        agentId: 'agent.python-test',
        metadata: {},
      })
      await server.runtime.run(spec.id)
      const snapshot = await server.runtime.getSnapshot(spec.id)
      expect(snapshot.state).toBe('completed')
      const output = snapshot.result as {
        toolResults: { output: { answer: unknown } }[]
      }
      expect(output.toolResults[0]?.output).toEqual({
        answer: 1267650600228229401496703205376,
      })
    } finally {
      await server.app.close()
    }
  })
})
