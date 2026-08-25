import { describe, expect, it } from 'vitest'
import { CalculatorError, evaluateExpression } from '../src/index.ts'

describe('evaluateExpression', () => {
  it.each([
    ['1 + 2', 3],
    ['7-3', 4],
    ['2 * 3', 6],
    ['10 / 4', 2.5],
    ['10 % 3', 1],
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['2 ^ 10', 1024],
    ['2 ^ 3 ^ 2', 512],
    ['-3 + 5', 2],
    ['--4', 4],
    ['+7', 7],
    ['-(2 + 3)', -5],
    ['3.5 * 2', 7],
    ['  2*\t( 3 + 4 ) ', 14],
    ['100 / 5 / 2', 10],
    ['2 - 3 - 4', -5],
    ['2 * 3 + 4 * 5', 26],
    ['1.5 + 1.25', 2.75],
    ['0', 0],
  ])('evaluates %s to %d', (expression, expected) => {
    expect(evaluateExpression(expression)).toBe(expected)
  })

  it('rejects division and modulo by zero', () => {
    expect(() => evaluateExpression('1 / 0')).toThrow(CalculatorError)
    expect(() => evaluateExpression('5 % 0')).toThrow(CalculatorError)
  })

  it('rejects malformed expressions', () => {
    expect(() => evaluateExpression('')).toThrow(CalculatorError)
    expect(() => evaluateExpression('1 +')).toThrow(CalculatorError)
    expect(() => evaluateExpression('(1 + 2')).toThrow(CalculatorError)
    expect(() => evaluateExpression('1 + foo')).toThrow(CalculatorError)
    expect(() => evaluateExpression('1.')).toThrow(CalculatorError)
    expect(() => evaluateExpression('1 2')).toThrow(CalculatorError)
    expect(() => evaluateExpression(')')).toThrow(CalculatorError)
    expect(() => evaluateExpression('<script>')).toThrow(CalculatorError)
    expect(() => evaluateExpression('process.exit(1)')).toThrow(CalculatorError)
  })

  it('rejects non-finite results', () => {
    expect(() => evaluateExpression('9 ^ 9999')).toThrow(
      'result is not a finite number',
    )
  })
})
