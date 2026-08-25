import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { PythonTool, PythonToolError } from '../src/index.ts'

// The suite needs a python3 interpreter on PATH; it skips otherwise.
function hasPython(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!hasPython())('PythonTool', () => {
  it('returns printed stdout as plain text when it is not JSON', async () => {
    const tool = new PythonTool()
    await expect(tool.execute({ code: 'print("hello world")' })).resolves.toBe(
      'hello world\n',
    )
  })

  it('parses JSON stdout into structured output', async () => {
    const tool = new PythonTool()
    await expect(tool.execute({ code: 'print(1 + 1)' })).resolves.toBe(2)
    await expect(
      tool.execute({
        code: 'import json; print(json.dumps({"value": args["x"] * 2}))',
        args: { x: 21 },
      }),
    ).resolves.toEqual({ value: 42 })
  })

  it('exposes args to the code', async () => {
    const tool = new PythonTool()
    await expect(
      tool.execute({
        code: 'print(args["greeting"], args["who"])',
        args: { greeting: 'hello', who: 'world' },
      }),
    ).resolves.toBe('hello world\n')
  })

  it('maps exceptions to tool errors with the traceback tail', async () => {
    const tool = new PythonTool()
    const error = (await tool
      .execute({ code: 'raise ValueError("nope")' })
      .catch((reason: unknown) => reason)) as PythonToolError
    expect(error).toBeInstanceOf(PythonToolError)
    expect(error.message).toMatch(/ValueError: nope/)
  })

  it('kills runaway code at the timeout', async () => {
    const tool = new PythonTool({ timeoutMs: 500 })
    await expect(
      tool.execute({ code: 'import time; time.sleep(30); print("late")' }),
    ).rejects.toThrow(/exceeded the 500ms limit/)
  })

  it('caps oversized output', async () => {
    const tool = new PythonTool({ maxOutputBytes: 64 })
    await expect(tool.execute({ code: 'print("x" * 100000)' })).rejects.toThrow(
      /exceeded 64 bytes/,
    )
  })

  it('rejects empty code and reports missing interpreters clearly', async () => {
    const tool = new PythonTool()
    await expect(tool.execute({ code: '   ' })).rejects.toThrow(
      /non-empty string/,
    )

    const missing = new PythonTool({ command: 'python3-definitely-missing' })
    await expect(missing.execute({ code: 'print(1)' })).rejects.toThrow(
      /Failed to run 'python3-definitely-missing'/,
    )
  })
})
