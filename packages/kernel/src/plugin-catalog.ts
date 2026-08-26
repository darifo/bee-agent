import type { RuntimePlugin } from './kernel.ts'
import { PluginManifestSchema, type PluginManifest } from './plugin.ts'
import type { EffectivePlugin, EffectiveStructure } from './structure.ts'

export const BEE_PLUGIN_API_VERSION = '1'

export type CatalogPluginFactory = (
  entry: EffectivePlugin,
  structure: EffectiveStructure,
) => RuntimePlugin | Promise<RuntimePlugin>

export interface PluginCatalogRegistration {
  readonly manifest: PluginManifest
  readonly create: CatalogPluginFactory
}

export class PluginNotInstalledError extends Error {
  constructor(
    readonly reference: { readonly id: string; readonly version: string },
  ) {
    super(`Plugin '${reference.id}@${reference.version}' is not installed`)
    this.name = 'PluginNotInstalledError'
  }
}

export class PluginApiVersionError extends Error {
  constructor(
    readonly pluginId: string,
    readonly requested: string,
  ) {
    super(
      `Plugin '${pluginId}' requires plugin API '${requested}', expected '${BEE_PLUGIN_API_VERSION}'`,
    )
    this.name = 'PluginApiVersionError'
  }
}

/**
 * Trusted, process-local plugin resolver. A manifest's `entry` is package
 * metadata only: desired-state documents can select an installed registration
 * but can never make the kernel import or execute an arbitrary path.
 */
export class PluginCatalog {
  readonly #registrations = new Map<string, PluginCatalogRegistration>()

  register(input: PluginCatalogRegistration): () => void {
    const manifest = PluginManifestSchema.parse(input.manifest)
    if (manifest.engine.pluginApi !== BEE_PLUGIN_API_VERSION) {
      throw new PluginApiVersionError(manifest.id, manifest.engine.pluginApi)
    }
    const key = `${manifest.id}@${manifest.version}`
    if (this.#registrations.has(key)) {
      throw new Error(`Plugin '${key}' is already registered`)
    }
    const registration = { manifest, create: input.create }
    this.#registrations.set(key, registration)
    return () => {
      if (this.#registrations.get(key) === registration) {
        this.#registrations.delete(key)
      }
    }
  }

  list(): readonly PluginManifest[] {
    return [...this.#registrations.values()].map(({ manifest }) => manifest)
  }

  async resolve(
    entry: EffectivePlugin,
    structure: EffectiveStructure,
  ): Promise<RuntimePlugin> {
    const key = `${entry.ref.id}@${entry.ref.version}`
    const registration = this.#registrations.get(key)
    if (registration === undefined) throw new PluginNotInstalledError(entry.ref)
    const plugin = await registration.create(entry, structure)
    if (plugin.id !== entry.id) {
      throw new Error(
        `Plugin factory '${key}' returned instance '${plugin.id}', expected '${entry.id}'`,
      )
    }
    if (plugin.version !== entry.ref.version) {
      throw new Error(
        `Plugin factory '${key}' returned version '${plugin.version}', expected '${entry.ref.version}'`,
      )
    }
    const providedServices = registration.manifest.capabilities
      .filter(({ type }) => type === 'service')
      .map(({ name }) => name)
    const factoryServices = [...(plugin.provides ?? [])].sort()
    const manifestServices = [...providedServices].sort()
    if (factoryServices.join('\0') !== manifestServices.join('\0')) {
      throw new Error(
        `Plugin factory '${key}' service declarations do not match its manifest`,
      )
    }
    return {
      ...plugin,
      config: entry.config !== undefined ? entry.config : plugin.config,
      inject: registration.manifest.requires,
      provides: providedServices,
      replacementTier: registration.manifest.replacementTier,
    }
  }
}
