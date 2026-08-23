import { describe, expect, it } from 'vitest'
import { PluginManifestSchema } from '@bee-agent/plugin-sdk'
import manifestJson from '../plugin.manifest.json' with { type: 'json' }
import {
  CALCULATOR_TOOL_ID,
  CalculatorPlugin,
  CalculatorTool,
} from '../src/index.js'

describe('calculator tool', () => {
  it('evaluates expressions from tool input', () => {
    const tool = new CalculatorTool()
    expect(tool.manifest.id).toBe(CALCULATOR_TOOL_ID)
    expect(tool.execute({ expression: '1 + 2 * 3' })).toEqual({
      value: 7,
    })
  })

  it('rejects missing or invalid expression input', () => {
    const tool = new CalculatorTool()
    expect(() => tool.execute({})).toThrow('expression')
    expect(() => tool.execute({ expression: '   ' })).toThrow('expression')
    expect(() => tool.execute({ expression: 42 })).toThrow('expression')
  })
})

describe('calculator plugin', () => {
  it('exposes a valid manifest and a ready tool', async () => {
    const plugin = new CalculatorPlugin()
    expect(plugin.manifest).toEqual(PluginManifestSchema.parse(manifestJson))
    expect(plugin.manifest.id).toBe('tools.calculator')
    expect(plugin.manifest.capabilities).toEqual([
      { type: 'tool', name: 'calculator' },
    ])
    expect(plugin.tool.manifest.id).toBe(CALCULATOR_TOOL_ID)
    await expect(plugin.start()).resolves.toBeUndefined()
    await expect(plugin.stop()).resolves.toBeUndefined()
  })
})
