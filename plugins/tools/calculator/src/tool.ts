import type { Tool } from '@bee-agent/runtime'
import { CalculatorError, evaluateExpression } from './evaluate.js'

export const CALCULATOR_TOOL_ID = 'tools.calculator'

export interface CalculatorOutput {
  readonly value: number
}

/**
 * Reference tool implementation: evaluates arithmetic expressions safely
 * (no `eval`) and reports failures by throwing, which the task runtime turns
 * into tool result errors.
 */
export class CalculatorTool implements Tool {
  readonly manifest = {
    id: CALCULATOR_TOOL_ID,
    name: 'Calculator',
    description:
      'Evaluates arithmetic expressions with +, -, *, /, %, ^, unary signs, and parentheses.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'Arithmetic expression, for example "1 + 2 * 3"',
        },
      },
      required: ['expression'],
    },
  } as const

  execute(input: Record<string, unknown>): CalculatorOutput {
    const expression = input.expression
    if (typeof expression !== 'string' || expression.trim().length === 0) {
      throw new CalculatorError("input 'expression' must be a non-empty string")
    }
    return { value: evaluateExpression(expression) }
  }
}
