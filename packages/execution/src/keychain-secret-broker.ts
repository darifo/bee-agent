import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { ActionRequest, SecretBroker } from './execution-world.ts'

export interface KeychainSecretRef {
  readonly service: string
  readonly account: string
}

export interface KeychainResolver {
  resolve(ref: KeychainSecretRef): Promise<string>
}

export function parseKeychainSecretRef(ref: string): KeychainSecretRef {
  const match = /^keychain:([^/]+)\/(.+)$/.exec(ref)
  if (match === null) {
    throw new Error('Secret references must use keychain:<service>/<account>')
  }
  try {
    const service = decodeURIComponent(match[1] as string)
    const account = decodeURIComponent(match[2] as string)
    if (service === '' || account === '')
      throw new Error('empty keychain field')
    return { service, account }
  } catch {
    throw new Error('Secret reference contains invalid percent encoding')
  }
}

class SecurityCliKeychainResolver implements KeychainResolver {
  async resolve(ref: KeychainSecretRef): Promise<string> {
    if (process.platform !== 'darwin' || !existsSync('/usr/bin/security')) {
      throw new Error('macOS Keychain is unavailable on this host')
    }
    return new Promise((resolve, reject) => {
      const child = spawn(
        '/usr/bin/security',
        ['find-generic-password', '-w', '-s', ref.service, '-a', ref.account],
        { env: {}, stdio: ['ignore', 'pipe', 'ignore'] },
      )
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        reject(new Error('Keychain lookup timed out'))
      }, 5_000)
      timer.unref()
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return
        size += chunk.byteLength
        if (size > 65_536) {
          settled = true
          clearTimeout(timer)
          child.kill('SIGKILL')
          reject(new Error('Keychain value exceeds the supported size'))
          return
        }
        chunks.push(chunk)
      })
      child.once('error', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error('Keychain lookup could not be started'))
      })
      child.once('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code !== 0) {
          reject(new Error('Keychain item was not found or access was denied'))
          return
        }
        const value = Buffer.concat(chunks)
          .toString('utf8')
          .replace(/\r?\n$/, '')
        if (value === '') {
          reject(new Error('Keychain item has an empty value'))
          return
        }
        resolve(value)
      })
    })
  }
}

/** Late-binds macOS Keychain values and remembers only values needed for redaction. */
export class MacOSKeychainSecretBroker implements SecretBroker {
  readonly #resolver: KeychainResolver
  readonly #materialized = new Map<string, Set<string>>()

  constructor(resolver: KeychainResolver = new SecurityCliKeychainResolver()) {
    this.#resolver = resolver
  }

  async materialize(
    refs: readonly string[],
    request: ActionRequest,
  ): Promise<ReadonlyMap<string, string>> {
    const values = new Map<string, string>()
    const requestValues = new Set<string>()
    this.#materialized.set(request.id, requestValues)
    for (const ref of new Set(refs)) {
      const value = await this.#resolver.resolve(parseKeychainSecretRef(ref))
      requestValues.add(value)
      values.set(ref, value)
    }
    return values
  }

  redact(value: string): string {
    let redacted = value
    const secrets = [
      ...new Set([...this.#materialized.values()].flatMap((set) => [...set])),
    ].sort((left, right) => right.length - left.length)
    for (const secret of secrets)
      redacted = redacted.split(secret).join('[REDACTED]')
    return redacted
  }

  release(_refs: readonly string[], request: ActionRequest): void {
    this.#materialized.delete(request.id)
  }
}
