/** One parsed Server-Sent Events frame. */
export interface SseFrame {
  readonly id: string | undefined
  readonly event: string | undefined
  readonly data: string
}

/**
 * Parses `text/event-stream` frames from a byte stream. Frames are separated
 * by blank lines; `id:`, `event:`, and `data:` fields are collected, comment
 * lines starting with `:` are ignored, and multiple `data:` lines join with
 * newlines, following the SSE specification.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame, void, unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = findFrameBoundary(buffer)
      while (boundary !== undefined) {
        const raw = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.end)
        const frame = parseFrame(raw)
        if (frame) yield frame
        boundary = findFrameBoundary(buffer)
      }
    }
    buffer += decoder.decode()
    const frame = parseFrame(buffer)
    if (frame) yield frame
  } finally {
    reader.releaseLock()
  }
}

function findFrameBoundary(
  buffer: string,
): { index: number; end: number } | undefined {
  const unix = buffer.indexOf('\n\n')
  const windows = buffer.indexOf('\r\n\r\n')
  if (unix === -1 && windows === -1) return undefined
  if (unix !== -1 && (windows === -1 || unix < windows)) {
    return { index: unix, end: unix + 2 }
  }
  return { index: windows, end: windows + 4 }
}

function parseFrame(raw: string): SseFrame | undefined {
  let id: string | undefined
  let event: string | undefined
  const data: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    let value = separator === -1 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'id') id = value
    else if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  if (id === undefined && event === undefined && data.length === 0) {
    return undefined
  }
  return { id, event, data: data.join('\n') }
}
