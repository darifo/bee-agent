import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TIME_ZONE,
  TimeService,
  TIME_NOW_TOOL_ID,
  createTimeNowTool,
  createTimeRetrieveHook,
} from '../src/time.ts'

function withDateHeader(date: string, ok = true): typeof fetch {
  return vi.fn(async () =>
    ok
      ? new Response('', { headers: { date } })
      : new Response('', { status: 500 }),
  ) as unknown as typeof fetch
}

/**
 * Accurate time for the agent: the service calibrates its local clock from
 * HTTP Date headers (falling back silently when sources fail), formats in
 * the configured zone (UTC+8 by default), feeds the per-request injection
 * message, and backs the built-in time_now tool.
 */
describe('TimeService', () => {
  it('formats the default UTC+8 zone with weekday and offset label', () => {
    const time = new TimeService({ fetch: withDateHeader('x') })
    const snapshot = time.snapshot()
    expect(snapshot.timezone).toBe(DEFAULT_TIME_ZONE)
    expect(snapshot.timezone).toBe('Asia/Shanghai')
    expect(snapshot.utcOffset).toBe('UTC+8')
    expect(snapshot.zoned).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect([
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ]).toContain(snapshot.weekday)
    // UTC instant and zoned wall clock are exactly eight hours apart
    // (the wall clock carries second precision).
    expect(
      Math.abs(
        Date.parse(`${snapshot.zoned.replace(' ', 'T')}+08:00`) -
          Date.parse(snapshot.utc),
      ),
    ).toBeLessThan(1_000)
    expect(snapshot.networkCalibrated).toBe(false)
  })

  it('honors an explicit timezone', () => {
    const time = new TimeService({
      timezone: 'UTC',
      fetch: withDateHeader('x'),
    })
    const snapshot = time.snapshot()
    expect(snapshot.utcOffset).toBe('UTC+0')
    expect(
      Math.abs(
        Date.parse(`${snapshot.zoned.replace(' ', 'T')}Z`) -
          Date.parse(snapshot.utc),
      ),
    ).toBeLessThan(1_000)
  })

  it('calibrates from the first HTTP Date header that answers', async () => {
    const serverTime = '2026-09-01T04:00:00.000Z'
    const failing = vi.fn(async () => new Response('', { status: 503 }))
    const time = new TimeService({
      networkSources: ['https://down.example.com', 'https://up.example.com'],
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('down.example')) return failing()
        return new Response('', {
          headers: { date: new Date(serverTime).toUTCString() },
        })
      }) as unknown as typeof fetch,
    })
    const calibrated = await time.calibrate()
    expect(calibrated).toBe(true)
    const snapshot = time.snapshot()
    expect(snapshot.networkCalibrated).toBe(true)
    expect(snapshot.source).toBe('https://up.example.com')
    // The calibrated clock matches the server's second.
    expect(
      Math.abs(time.now().getTime() - Date.parse(serverTime)),
    ).toBeLessThan(1_500)
  })

  it('keeps the local clock when every source fails', async () => {
    const time = new TimeService({ fetch: withDateHeader('x', false) })
    const calibrated = await time.calibrate()
    expect(calibrated).toBe(false)
    expect(time.snapshot().networkCalibrated).toBe(false)
    expect(time.snapshot().offsetMs).toBe(0)
  })

  it('promptMessage states the zone, offset, and calibration source', async () => {
    const time = new TimeService({ fetch: withDateHeader('x') })
    const before = time.promptMessage()
    expect(before).toContain('Asia/Shanghai (UTC+8)')
    expect(before).toContain('not yet network-calibrated')
    expect(before).toContain('Treat this as "now"')

    const calibrated = new TimeService({
      networkSources: ['https://clock.example.com'],
      fetch: withDateHeader(new Date().toUTCString()),
    })
    await calibrated.calibrate()
    const after = calibrated.promptMessage()
    expect(after).toContain(
      'network-calibrated against https://clock.example.com',
    )
    expect(after).toMatch(/- UTC: \d{4}-\d{2}-\d{2}T/)
  })
})

describe('time_now tool and injection hook', () => {
  it('describes a side-effect-free always-allowed parallel tool', () => {
    const time = new TimeService({ fetch: withDateHeader('x') })
    const tool = createTimeNowTool(time)
    expect(tool.spec.id).toBe(TIME_NOW_TOOL_ID)
    expect(tool.authorization.decision).toBe('allow')
    const descriptor = tool.describe({
      callId: 'c1',
      toolId: TIME_NOW_TOOL_ID,
      input: {},
    })
    expect(descriptor.requirements.networkTargets).toEqual([])
    expect(descriptor.requirements.commands).toEqual([])
    expect(() =>
      tool.describe({ callId: 'c1', toolId: 'other', input: {} }),
    ).toThrow(/cannot describe/)
  })

  it('executes to a formatted snapshot', async () => {
    const time = new TimeService({ fetch: withDateHeader('x') })
    const tool = createTimeNowTool(time)
    const result = await tool.execute({
      call: { callId: 'c1', toolId: TIME_NOW_TOOL_ID, input: {} },
      threadId: threadId,
      turnId: turnId,
      itemId: 'i1',
    })
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('Asia/Shanghai (UTC+8):')
    expect(result.content).toContain('UTC:')
  })

  it('injects the current time as a late system message', async () => {
    const time = new TimeService({ fetch: withDateHeader('x') })
    const hook = createTimeRetrieveHook(time)
    const messages = await hook.retrieve({
      threadId,
      turnId,
      input: 'hi',
      history: [],
      stepIndex: 0,
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('system')
    expect(messages[0]!.content).toContain('Current date-time')
  })
})

const threadId = '11111111-1111-4111-8111-111111111111'
const turnId = '22222222-2222-4222-8222-222222222222'
