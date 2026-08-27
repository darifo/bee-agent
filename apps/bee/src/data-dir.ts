import { isAbsolute, resolve } from 'node:path'

/**
 * The unified personal data directory (v1 refactor plan §5.5 Phase 4,
 * threat-model data-layout design): one predictable root for every durable
 * Host artifact. `BEE_AGENT_DATA_DIR` wins when set; otherwise the platform
 * convention applies — `~/Library/Application Support/bee-agent` on macOS,
 * `$XDG_DATA_HOME/bee-agent` (defaulting to `~/.local/share/bee-agent`)
 * elsewhere.
 */

export interface DataDirInput {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  readonly platform: NodeJS.Platform
}

export function resolveBeeDataDir(input: DataDirInput): string {
  const explicit = input.env.BEE_AGENT_DATA_DIR?.trim()
  if (explicit !== undefined && explicit !== '') {
    return isAbsolute(explicit) ? explicit : resolve(explicit)
  }
  if (input.platform === 'darwin') {
    return resolve(input.home, 'Library', 'Application Support', 'bee-agent')
  }
  const xdg = input.env.XDG_DATA_HOME?.trim()
  const dataRoot =
    xdg !== undefined && xdg !== '' && isAbsolute(xdg)
      ? xdg
      : resolve(input.home, '.local', 'share')
  return resolve(dataRoot, 'bee-agent')
}
