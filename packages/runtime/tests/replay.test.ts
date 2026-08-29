import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  fixturesDir,
  normalizeForReplay,
  readFixture,
  runSession,
  writeRecordedFixture,
} from './replay/harness.ts'

/**
 * Keyless replay of recorded sessions. Fixtures under
 * `tests/replay/fixtures/` script model responses and tool outcomes; this
 * test runs the real pipeline and diffs the durable facts (turn results,
 * exact model-visible requests, every Chronicle stream) against the
 * recorded expectation. Regenerate after an intentional protocol change:
 *
 *   REPLAY_RECORD=1 pnpm --filter @bee-agent/runtime test
 */

const RECORD = process.env.REPLAY_RECORD === '1'

const files = (await readdir(fixturesDir())).filter((file) =>
  file.endsWith('.json'),
)

describe('recorded session replay', () => {
  it('has fixtures to replay', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    it(`replays ${file}`, async () => {
      const path = join(fixturesDir(), file)
      const fixture = await readFixture(path)
      const recording = await runSession(fixture)

      if (RECORD) {
        await writeRecordedFixture(path, fixture, recording)
        return
      }

      expect(
        fixture.expected,
        `${file}: no recorded expectation — run once with REPLAY_RECORD=1`,
      ).toBeDefined()
      const expected = fixture.expected
      if (expected === undefined) return
      const actual = normalizeForReplay(recording) as typeof expected

      expect(actual.results, `${file}: turn results drifted`).toEqual(
        expected.results,
      )
      expect(
        actual.modelCalls,
        `${file}: model-visible requests drifted`,
      ).toEqual(expected.modelCalls)
      expect(actual.streams, `${file}: Chronicle streams drifted`).toEqual(
        expected.streams,
      )
    })
  }
})
