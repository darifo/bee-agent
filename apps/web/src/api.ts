import { BeeAgentClient } from '@bee-agent/client'

/**
 * Server base URL. `VITE_BEE_AGENT_URL` is baked in at build time; it
 * defaults to the local development server.
 */
export const baseUrl =
  import.meta.env.VITE_BEE_AGENT_URL ?? 'http://127.0.0.1:3000'

export function createApiClient(): BeeAgentClient {
  return new BeeAgentClient({ baseUrl })
}
