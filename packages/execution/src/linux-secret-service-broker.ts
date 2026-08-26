import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { ActionRequest, SecretBroker } from './execution-world.ts'

export interface SecretServiceRef {
  readonly service: string
  readonly account: string
}

export interface SecretServiceResolver {
  resolve(ref: SecretServiceRef): Promise<string>
}

export function parseSecretServiceRef(ref: string): SecretServiceRef {
  const match = /^secret-service:([^/]+)\/(.+)$/.exec(ref)
  if (match === null)
    throw new Error(
      'Secret references must use secret-service:<service>/<account>',
    )
  try {
    const service = decodeURIComponent(match[1] as string)
    const account = decodeURIComponent(match[2] as string)
    if (service === '' || account === '') throw new Error('empty field')
    return { service, account }
  } catch {
    throw new Error('Secret reference contains invalid percent encoding')
  }
}

class SecretToolResolver implements SecretServiceResolver {
  async resolve(ref: SecretServiceRef): Promise<string> {
    const executable = ['/usr/bin/secret-tool', '/bin/secret-tool'].find(
      existsSync,
    )
    if (process.platform !== 'linux' || executable === undefined)
      throw new Error('Linux Secret Service is unavailable on this host')
    const bus = process.env.DBUS_SESSION_BUS_ADDRESS
    return new Promise((resolve, reject) => {
      const child = spawn(
        executable,
        ['lookup', 'service', ref.service, 'account', ref.account],
        {
          env: bus === undefined ? {} : { DBUS_SESSION_BUS_ADDRESS: bus },
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      )
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      const fail = (message: string) => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        reject(new Error(message))
      }
      const timer = setTimeout(
        () => fail('Secret Service lookup timed out'),
        5_000,
      )
      timer.unref()
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.byteLength
        if (size > 65_536) {
          clearTimeout(timer)
          fail('Secret Service value exceeds the supported size')
          return
        }
        chunks.push(chunk)
      })
      child.once('error', () => {
        clearTimeout(timer)
        fail('Secret Service lookup could not be started')
      })
      child.once('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code !== 0) {
          reject(
            new Error('Secret Service item was not found or access was denied'),
          )
          return
        }
        const value = Buffer.concat(chunks)
          .toString('utf8')
          .replace(/\r?\n$/, '')
        if (value === '') {
          reject(new Error('Secret Service item has an empty value'))
          return
        }
        resolve(value)
      })
    })
  }
}

export class LinuxSecretServiceBroker implements SecretBroker {
  readonly #resolver: SecretServiceResolver
  readonly #materialized = new Map<string, Set<string>>()

  constructor(resolver: SecretServiceResolver = new SecretToolResolver()) {
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
      const value = await this.#resolver.resolve(parseSecretServiceRef(ref))
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
