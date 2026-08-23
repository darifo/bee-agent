import { z } from 'zod'

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
