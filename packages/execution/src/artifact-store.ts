import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Content-addressed artifact storage (v1 refactor plan §5.2 P1-7): large
 * payloads live in the artifact store and Chronicle events carry only the
 * digest reference, so the event log stays small and replays stay cheap.
 */

export interface ArtifactRef {
  /** `sha256:<64 lowercase hex>` content digest. */
  readonly digest: string
  /** Content size in bytes. */
  readonly size: number
}

export class ArtifactNotFoundError extends Error {
  constructor(readonly digest: string) {
    super(`Artifact '${digest}' was not found`)
    this.name = 'ArtifactNotFoundError'
  }
}

export class InvalidArtifactDigestError extends Error {
  constructor(readonly digest: string) {
    super(`'${digest}' is not a valid sha256 artifact digest`)
    this.name = 'InvalidArtifactDigestError'
  }
}

export interface ArtifactStore {
  /** Stores content once; identical content returns the same ref. */
  put(data: Uint8Array | string): Promise<ArtifactRef>
  /** Reads content back; missing artifacts fail with an explicit error. */
  get(digest: string): Promise<Uint8Array>
  has(digest: string): Promise<boolean>
}

export interface SecretScanner {
  redact(value: string): string
}

export class ArtifactSecretLeakError extends Error {
  constructor() {
    super('Artifact content contains materialized secret data')
    this.name = 'ArtifactSecretLeakError'
  }
}

/** Rejects secret-bearing artifacts before bytes reach durable storage. */
export class SecretScanningArtifactStore implements ArtifactStore {
  readonly #inner: ArtifactStore
  readonly #scanner: SecretScanner

  constructor(inner: ArtifactStore, scanner: SecretScanner) {
    this.#inner = inner
    this.#scanner = scanner
  }

  put(data: Uint8Array | string): Promise<ArtifactRef> {
    const content =
      typeof data === 'string' ? data : new TextDecoder().decode(data)
    if (this.#scanner.redact(content) !== content)
      return Promise.reject(new ArtifactSecretLeakError())
    return this.#inner.put(data)
  }

  get(digest: string): Promise<Uint8Array> {
    return this.#inner.get(digest)
  }

  has(digest: string): Promise<boolean> {
    return this.#inner.has(digest)
  }
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

export function isValidArtifactDigest(digest: string): boolean {
  return DIGEST_PATTERN.test(digest)
}

function assertDigest(digest: string): void {
  if (!isValidArtifactDigest(digest))
    throw new InvalidArtifactDigestError(digest)
}

function digestOf(content: Uint8Array): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

/**
 * Filesystem {@link ArtifactStore}: content is stored under `rootDir`,
 * sharded by the first two hex characters of the digest
 * (`rootDir/ab/abcdef…`). Writes go through a temp file plus rename so a
 * crashed writer never leaves a partial artifact under a valid digest.
 */
export class LocalArtifactStore implements ArtifactStore {
  readonly #rootDir: string

  constructor(rootDir: string) {
    this.#rootDir = rootDir
  }

  async put(data: Uint8Array | string): Promise<ArtifactRef> {
    const content =
      typeof data === 'string' ? new TextEncoder().encode(data) : data
    const digest = digestOf(content)
    const target = this.#pathFor(digest)
    // First writer wins; concurrent puts of the same content are idempotent.
    if (await this.has(digest)) return { digest, size: content.byteLength }

    await mkdir(dirname(target), { recursive: true })
    const temp = join(dirname(target), `.tmp-${randomUUID()}`)
    await writeFile(temp, content)
    await rename(temp, target)
    return { digest, size: content.byteLength }
  }

  async get(digest: string): Promise<Uint8Array> {
    assertDigest(digest)
    try {
      return new Uint8Array(await readFile(this.#pathFor(digest)))
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: string }).code === 'ENOENT'
      ) {
        throw new ArtifactNotFoundError(digest)
      }
      throw error
    }
  }

  async has(digest: string): Promise<boolean> {
    if (!isValidArtifactDigest(digest)) return false
    try {
      await readFile(this.#pathFor(digest))
      return true
    } catch {
      return false
    }
  }

  #pathFor(digest: string): string {
    const hex = digest.slice('sha256:'.length)
    return join(this.#rootDir, hex.slice(0, 2), hex)
  }
}
