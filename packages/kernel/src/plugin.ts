import { z } from 'zod'

/** Static package metadata. Runtime activation is expressed by
 * `RuntimePlugin.apply(ctx, config)` and owned by its Fiber. */

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
  replacementTier: z.enum(['a', 'b', 'c']).default('b'),
  integrity: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .optional(),
  entry: z.string().min(1),
})
export type PluginManifest = z.infer<typeof PluginManifestSchema>
