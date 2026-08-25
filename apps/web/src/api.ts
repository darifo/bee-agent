import { BeeAgentClient } from '@bee-agent/client'

/**
 * Server base URL. `VITE_BEE_AGENT_URL` is baked in at build time; it
 * defaults to the local host. The one-time session token comes from
 * `VITE_BEE_AGENT_SESSION_TOKEN` when the host enforces one.
 */
export const baseUrl =
  import.meta.env.VITE_BEE_AGENT_URL ?? 'http://127.0.0.1:3000'

export function createApiClient(): BeeAgentClient {
  const sessionToken = import.meta.env.VITE_BEE_AGENT_SESSION_TOKEN as
    string | undefined
  return new BeeAgentClient({
    baseUrl,
    ...(sessionToken !== undefined && sessionToken !== ''
      ? { sessionToken }
      : {}),
  })
}
