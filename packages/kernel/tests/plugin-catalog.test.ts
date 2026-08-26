import { describe, expect, it } from 'vitest'
import {
  BEE_PLUGIN_API_VERSION,
  BundleSchema,
  PluginCatalog,
  PluginNotInstalledError,
  resolveEffectiveStructure,
} from '../src/index.ts'

async function structure() {
  return resolveEffectiveStructure(
    BundleSchema.parse({
      id: 'test',
      version: '1',
      model: { id: 'm', version: '1' },
      prompt: { id: 'p', version: '1' },
      contextPolicy: { id: 'c', version: '1' },
      memoryView: { id: 'mv', version: '1' },
      sandbox: { id: 's', version: '1' },
      evalPolicy: { id: 'e', version: '1' },
      plugins: [
        {
          id: 'greeter.primary',
          ref: { id: 'greeter', version: '1.0.0' },
          config: { greeting: 'hello' },
        },
      ],
    }),
  )
}

describe('PluginCatalog', () => {
  it('resolves exact trusted registrations and applies manifest policy', async () => {
    const catalog = new PluginCatalog()
    catalog.register({
      manifest: {
        id: 'greeter',
        name: 'Greeter',
        version: '1.0.0',
        engine: { pluginApi: BEE_PLUGIN_API_VERSION },
        requires: ['clock'],
        capabilities: [],
        permissions: [],
        replacementTier: 'a',
        entry: './dist/index.js',
      },
      create(entry) {
        return {
          id: entry.id,
          version: entry.ref.version,
          apply() {},
        }
      },
    })
    const selected = await structure()
    const plugin = await catalog.resolve(selected.plugins[0]!, selected)
    expect(plugin).toMatchObject({
      id: 'greeter.primary',
      config: { greeting: 'hello' },
      inject: ['clock'],
      replacementTier: 'a',
    })
  })

  it('does not import unregistered manifest entries', async () => {
    const selected = await structure()
    await expect(
      new PluginCatalog().resolve(selected.plugins[0]!, selected),
    ).rejects.toBeInstanceOf(PluginNotInstalledError)
  })
})
