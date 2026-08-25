import { describe, expect, it } from 'vitest'
import { PluginManifestSchema } from '../src/index.ts'

describe('PluginManifestSchema', () => {
  it('normalizes optional declaration lists', () => {
    const manifest = PluginManifestSchema.parse({
      id: 'tools.calculator',
      name: 'Calculator',
      version: '0.1.0',
      engine: { pluginApi: '>=0.1.0 <0.2.0' },
      entry: './dist/index.js',
    })
    expect(manifest.requires).toEqual([])
    expect(manifest.capabilities).toEqual([])
    expect(manifest.permissions).toEqual([])
  })
})
