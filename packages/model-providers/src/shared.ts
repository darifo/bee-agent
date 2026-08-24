import { ModelProviderError } from './errors.js'

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'

export interface HttpOptions {
  /** Fetch implementation; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch | undefined
  /** Request timeout in milliseconds; defaults to 120000. */
  readonly timeoutMs?: number | undefined
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

export async function postJson(
  url: string,
  apiKey: string,
  body: unknown,
  options: HttpOptions,
): Promise<unknown> {
  const fetchImpl = options.fetch ?? fetch.bind(globalThis)
  const timeoutMs = options.timeoutMs ?? 120_000
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new ModelProviderError(
        `Request to ${url} timed out after ${timeoutMs}ms`,
      )
    }
    throw error
  }
  const text = await response.text()
  const parsed: unknown = text.length > 0 ? safeJsonParse(text) : undefined
  if (!response.ok) {
    const message =
      isRecord(parsed) && typeof parsed.error === 'object'
        ? errorMessage(parsed.error)
        : `HTTP ${response.status}`
    throw new ModelProviderError(
      `Model provider rejected the request: ${message}`,
      response.status,
      parsed,
    )
  }
  return parsed
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function errorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message
  }
  return 'unknown error'
}

export function requireRecord(
  value: unknown,
  what: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ModelProviderError(`${what} is missing from the response`)
  }
  return value
}
