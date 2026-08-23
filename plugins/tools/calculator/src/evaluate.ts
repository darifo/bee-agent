export class CalculatorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CalculatorError'
  }
}

type Token =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'operator'; readonly operator: string }

/**
 * Tokenizes an arithmetic expression into numbers and operators. Whitespace
 * is insignificant; anything else is a syntax error.
 */
function tokenize(expression: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < expression.length) {
    const char = expression[index]!
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1
      continue
    }
    if (char >= '0' && char <= '9') {
      let digits = char
      index += 1
      while (
        index < expression.length &&
        expression[index]! >= '0' &&
        expression[index]! <= '9'
      ) {
        digits += expression[index]
        index += 1
      }
      if (expression[index] === '.') {
        digits += '.'
        index += 1
        if (
          index >= expression.length ||
          !(expression[index]! >= '0' && expression[index]! <= '9')
        ) {
          throw new CalculatorError(
            `expected digits after the decimal point at position ${index}`,
          )
        }
        while (
          index < expression.length &&
          expression[index]! >= '0' &&
          expression[index]! <= '9'
        ) {
          digits += expression[index]
          index += 1
        }
      }
      tokens.push({ kind: 'number', value: Number(digits) })
      continue
    }
    if (
      char === '+' ||
      char === '-' ||
      char === '*' ||
      char === '/' ||
      char === '%' ||
      char === '^'
    ) {
      tokens.push({ kind: 'operator', operator: char })
      index += 1
      continue
    }
    if (char === '(' || char === ')') {
      tokens.push({ kind: 'operator', operator: char })
      index += 1
      continue
    }
    throw new CalculatorError(
      `unexpected character '${char}' at position ${index}`,
    )
  }
  return tokens
}

/**
 * Recursive-descent evaluator for arithmetic expressions with `+ - * / % ^`,
 * unary signs, and parentheses, evaluated without `eval`. `^` is
 * right-associative, everything else left-associative, with the usual
 * precedence.
 */
export function evaluateExpression(expression: string): number {
  const tokens = tokenize(expression)
  let position = 0

  const peek = (): Token | undefined => tokens[position]
  const next = (): Token => {
    const token = tokens[position]
    if (!token) throw new CalculatorError('unexpected end of expression')
    position += 1
    return token
  }
  const expectNumber = (): number => {
    const token = next()
    if (token.kind !== 'number') {
      throw new CalculatorError(
        `expected a number but got '${describe(token)}'`,
      )
    }
    return token.value
  }
  const describe = (token: Token): string =>
    token.kind === 'number' ? String(token.value) : token.operator

  const parseExpression = (): number => {
    let value = parseTerm()
    for (;;) {
      const token = peek()
      if (
        token?.kind === 'operator' &&
        (token.operator === '+' || token.operator === '-')
      ) {
        position += 1
        const right = parseTerm()
        value = token.operator === '+' ? value + right : value - right
      } else {
        return value
      }
    }
  }

  const parseTerm = (): number => {
    let value = parseFactor()
    for (;;) {
      const token = peek()
      if (
        token?.kind === 'operator' &&
        (token.operator === '*' ||
          token.operator === '/' ||
          token.operator === '%')
      ) {
        position += 1
        const right = parseFactor()
        if ((token.operator === '/' || token.operator === '%') && right === 0) {
          throw new CalculatorError('division by zero')
        }
        if (token.operator === '*') value *= right
        else if (token.operator === '/') value /= right
        else value %= right
      } else {
        return value
      }
    }
  }

  const parseFactor = (): number => {
    const base = parseUnary()
    const token = peek()
    if (token?.kind === 'operator' && token.operator === '^') {
      position += 1
      const exponent = parseFactor()
      return base ** exponent
    }
    return base
  }

  const parseUnary = (): number => {
    const token = peek()
    if (
      token?.kind === 'operator' &&
      (token.operator === '+' || token.operator === '-')
    ) {
      position += 1
      const value = parseUnary()
      return token.operator === '-' ? -value : value
    }
    return parsePrimary()
  }

  const parsePrimary = (): number => {
    const token = peek()
    if (token?.kind === 'operator' && token.operator === '(') {
      position += 1
      const value = parseExpression()
      const closing = next()
      if (closing.kind !== 'operator' || closing.operator !== ')') {
        throw new CalculatorError(`expected ')' but got '${describe(closing)}'`)
      }
      return value
    }
    return expectNumber()
  }

  const result = parseExpression()
  if (position !== tokens.length) {
    throw new CalculatorError(
      `unexpected '${describe(tokens[position]!)}' after the expression`,
    )
  }
  if (!Number.isFinite(result)) {
    throw new CalculatorError('result is not a finite number')
  }
  return result
}
