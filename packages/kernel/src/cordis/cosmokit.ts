/**
 * Minimal vendored subset of `cosmokit` (MIT, by Shigma), extracted from the
 * deepseek-harness `vendor/cosmokit` source to satisfy the ported cordis
 * runtime. Only the symbols cordis actually imports are included.
 */

/** String/symbol keyed dictionary type. */
export type Dict<T = any, K extends string | symbol = string> = {
  [key in K]: T
}

/** Wrap a value in `Promise`, preserving the resolved type of existing promises. */
export type Promisify<T> = Promise<T extends Promise<infer S> ? S : T>

/** Accept a value or promise unless the value type is already promise-like. */
export type Awaitable<T> = [T] extends [Promise<unknown>] ? T : T | Promise<T>

/** Return true when a value is `null` or `undefined`. */
export function isNullable(value: any): value is null | undefined | void {
  return value === null || value === undefined
}

export function defineProperty<T, K extends keyof T>(
  object: T,
  key: K,
  value: T[K],
): T
export function defineProperty<T, K extends keyof any>(
  object: T,
  key: K,
  value: any,
): T
export function defineProperty<T, K extends keyof any>(
  object: T,
  key: K,
  value: any,
) {
  return Object.defineProperty(object, key, {
    writable: true,
    value,
    enumerable: false,
  })
}

enum State {
  DELIM,
  UPPER,
  LOWER,
}

function tokenize(source: string, delimiters: number[], delimiter: number) {
  const output: number[] = []
  let state = State.DELIM
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i)
    if (code >= 65 && code <= 90) {
      if (state === State.UPPER) {
        const next = source.charCodeAt(i + 1)
        if (next >= 97 && next <= 122) {
          output.push(delimiter)
        }
        output.push(code + 32)
      } else {
        if (state !== State.DELIM) {
          output.push(delimiter)
        }
        output.push(code + 32)
      }
      state = State.UPPER
    } else if (code >= 97 && code <= 122) {
      output.push(code)
      state = State.LOWER
    } else if (delimiters.includes(code)) {
      if (state !== State.DELIM) {
        output.push(delimiter)
      }
      state = State.DELIM
    } else {
      output.push(code)
    }
  }
  return String.fromCharCode(...output)
}

/** Convert text to dash-delimited parameter case. */
function paramCase(source: string) {
  return tokenize(source, [45, 95], 45)
}

/** Runtime alias for `paramCase`. */
export const hyphenate = paramCase
