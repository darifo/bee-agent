import { describe, expect, it } from 'vitest'
import {
  GOLDEN_SCENARIOS,
  measureTokenBaseline,
  runTokenBaseline,
} from '../src/token-baseline.ts'

/** The CI gate: optimized context must stay well under the naive baseline. */
const SAVINGS_THRESHOLD = 0.6

describe('token baseline', () => {
  it('saves most of the full history/tools baseline across the golden set', () => {
    for (const scenario of GOLDEN_SCENARIOS) {
      const report = measureTokenBaseline(scenario)
      expect(report.optimizedTokens).toBeLessThan(report.baselineTokens)
      expect(report.savingsRatio).toBeLessThan(SAVINGS_THRESHOLD)
    }
  })

  it('is deterministic across runs', () => {
    expect(runTokenBaseline()).toEqual(runTokenBaseline())
  })

  it('cuts the long tail the most (tools and skills)', () => {
    const report = measureTokenBaseline(GOLDEN_SCENARIOS[0]!)
    expect(report.breakdown.tools.optimized).toBeLessThan(
      report.breakdown.tools.full,
    )
    expect(report.breakdown.skills.optimized).toBeLessThan(
      report.breakdown.skills.full,
    )
  })
})
