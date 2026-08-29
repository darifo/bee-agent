import { ModelProviderError } from './errors.ts'

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
  signal?: AbortSignal,
): Promise<unknown> {
  const fetchImpl = options.fetch ?? fetch.bind(globalThis)
  const timeoutMs = options.timeoutMs ?? 120_000
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const requestSignal =
    signal !== undefined
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: requestSignal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
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
      retryAfterMs(response),
    )
  }
  return parsed
}

/** Parses Retry-After (seconds or HTTP-date) into milliseconds. */
export function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')
  if (raw === null) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(raw)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

/**
 * POSTs and resolves as soon as the response headers arrive, so the body can
 * be consumed as a stream. The timeout covers headers only: a legitimately
 * long stream must not be killed by the request timeout. `ModelProviderError`
 * carries the status and any Retry-After hint, mirroring {@link postJson}.
 */
export async function postForStream(
  url: string,
  apiKey: string,
  body: unknown,
  options: HttpOptions,
  signal?: AbortSignal,
): Promise<Response> {
  const fetchImpl = options.fetch ?? fetch.bind(globalThis)
  const timeoutMs = options.timeoutMs ?? 120_000
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs)
  const requestSignal =
    signal !== undefined
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: requestSignal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    if (
      error instanceof Error &&
      (error.name === 'TimeoutError' || timeoutController.signal.aborted)
    ) {
      throw new ModelProviderError(
        `Request to ${url} timed out after ${timeoutMs}ms`,
      )
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    const text = await response.text()
    const parsed: unknown = text.length > 0 ? safeJsonParse(text) : undefined
    const message =
      isRecord(parsed) && typeof parsed.error === 'object'
        ? errorMessage(parsed.error)
        : `HTTP ${response.status}`
    throw new ModelProviderError(
      `Model provider rejected the request: ${message}`,
      response.status,
      parsed,
      retryAfterMs(response),
    )
  }
  return response
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
