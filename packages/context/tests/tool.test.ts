import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/tool-registry.ts'
import { measureToolContextCost } from '../src/tool.ts'
import type { ToolDefinition } from '../src/tool.ts'

function toolFixture(
  init: Partial<ToolDefinition> & Pick<ToolDefinition, 'id'>,
): ToolDefinition {
  return {
    description: 'A generic tool',
    inputSchema: { type: 'object', properties: {} },
    ...init,
  }
}

/** A bulky input schema, to make the full spec cost dominate the summary. */
function bigSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [
        `field_${i}`,
        { type: 'string', description: `Field number ${i}` },
      ]),
    ),
  }
}

describe('ToolRegistry', () => {
  it('keeps resident tools loaded and indexes the long tail', () => {
    const registry = new ToolRegistry()
    registry.register(
      toolFixture({
        id: 'core.calculator',
        description: 'Evaluate arithmetic',
        resident: true,
        inputSchema: { type: 'object', properties: {} },
      }),
    )
    registry.register(
      toolFixture({
        id: 'mcp.github',
        description: 'Browse GitHub repositories',
        tags: ['mcp', 'github'],
        inputSchema: bigSchema(),
      }),
    )

    expect(registry.residentSpecs().map((s) => s.id)).toEqual([
      'core.calculator',
    ])
    expect(registry.index().map((s) => s.id)).toEqual(['mcp.github'])
    expect(registry.resolve(['mcp.github']).map((s) => s.id)).toEqual([
      'mcp.github',
    ])
  })

  it('searches candidates only within the token budget', () => {
    const registry = new ToolRegistry()
    registry.register(
      toolFixture({
        id: 'mcp.github',
        description: 'Browse GitHub',
        tags: ['github'],
        inputSchema: bigSchema(),
      }),
    )
    registry.register(
      toolFixture({
        id: 'mcp.files',
        description: 'Read files',
        tags: ['fs'],
        inputSchema: bigSchema(),
      }),
    )

    // A one-token budget cannot afford any full spec.
    expect(registry.search('github', 1)).toEqual([])
    // A large budget fits the matched long-tail tool.
    expect(registry.search('github', 10000).map((s) => s.id)).toEqual([
      'mcp.github',
    ])
  })

  it('fails loud on a duplicate tool id', () => {
    const registry = new ToolRegistry()
    registry.register(toolFixture({ id: 'dup' }))
    expect(() => registry.register(toolFixture({ id: 'dup' }))).toThrow(
      /already registered/,
    )
  })

  it('costs far less in the two-stage index than the full-tool baseline', () => {
    const registry = new ToolRegistry()
    registry.register(
      toolFixture({
        id: 'core.calculator',
        description: 'Evaluate arithmetic',
        resident: true,
        inputSchema: { type: 'object', properties: {} },
      }),
    )
    for (const id of ['mcp.github', 'mcp.files', 'mcp.browser']) {
      registry.register(
        toolFixture({
          id,
          description: `Long-tail tool ${id}`,
          inputSchema: bigSchema(),
        }),
      )
    }

    const cost = measureToolContextCost(
      registry.residentSpecs(),
      registry.index(),
    )
    expect(cost.indexedTokens).toBeLessThan(cost.baselineTokens)
    expect(cost.residentTokens).toBeLessThan(cost.indexedTokens)
  })
})
