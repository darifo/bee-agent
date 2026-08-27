import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { resolveBeeDataDir } from '../src/data-dir.ts'

describe('resolveBeeDataDir', () => {
  it('honors an explicit absolute BEE_AGENT_DATA_DIR', () => {
    expect(
      resolveBeeDataDir({
        env: { BEE_AGENT_DATA_DIR: '/srv/bee' },
        home: '/Users/darifo',
        platform: 'darwin',
      }),
    ).toBe('/srv/bee')
  })

  it('resolves a relative BEE_AGENT_DATA_DIR against cwd', () => {
    expect(
      resolveBeeDataDir({
        env: { BEE_AGENT_DATA_DIR: 'bee-data' },
        home: '/Users/darifo',
        platform: 'darwin',
      }),
    ).toBe(resolve('bee-data'))
  })

  it('uses the macOS convention by default', () => {
    expect(
      resolveBeeDataDir({
        env: {},
        home: '/Users/darifo',
        platform: 'darwin',
      }),
    ).toBe('/Users/darifo/Library/Application Support/bee-agent')
  })

  it('uses XDG_DATA_HOME on linux when absolute', () => {
    expect(
      resolveBeeDataDir({
        env: { XDG_DATA_HOME: '/xdg/data' },
        home: '/home/darifo',
        platform: 'linux',
      }),
    ).toBe('/xdg/data/bee-agent')
    expect(
      resolveBeeDataDir({
        env: { XDG_DATA_HOME: 'relative/x' },
        home: '/home/darifo',
        platform: 'linux',
      }),
    ).toBe('/home/darifo/.local/share/bee-agent')
    expect(
      resolveBeeDataDir({
        env: {},
        home: '/home/darifo',
        platform: 'linux',
      }),
    ).toBe('/home/darifo/.local/share/bee-agent')
  })
})
