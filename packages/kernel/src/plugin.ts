import { z } from 'zod'

/**
 * The Bee Agent plugin contract (formerly `@bee-agent/plugin-sdk`, absorbed
 * into the kernel per the v1 plan §3.1). A plugin declares a stable manifest
 * and implements start/stop; the kernel manages its reversible lifecycle and
 * enforces the manifest's declared tier at mount time.
 */

export const PluginManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  engine: z.object({ pluginApi: z.string().min(1) }),
  requires: z.array(z.string()).default([]),
  capabilities: z
    .array(z.object({ type: z.string(), name: z.string() }))
    .default([]),
  permissions: z.array(z.string()).default([]),
  entry: z.string().min(1),
})
export type PluginManifest = z.infer<typeof PluginManifestSchema>

export interface BeeAgentPlugin {
  readonly manifest: PluginManifest
  start(): void | Promise<void>
  stop(): void | Promise<void>
}
