import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ArtifactNotFoundError,
  InvalidArtifactDigestError,
  LocalArtifactStore,
} from '../src/index.js'

let root: string
let store: LocalArtifactStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bee-artifacts-'))
  store = new LocalArtifactStore(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('LocalArtifactStore', () => {
  it('round-trips string and binary content under a sha256 ref', async () => {
    const text = await store.put('hello chronicle')
    expect(text.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(text.size).toBe('hello chronicle'.length)
    expect(new TextDecoder().decode(await store.get(text.digest))).toBe(
      'hello chronicle',
    )

    const binary = new Uint8Array([0, 1, 2, 255, 254])
    const binRef = await store.put(binary)
    expect(Array.from(await store.get(binRef.digest))).toEqual([
      0, 1, 2, 255, 254,
    ])
  })

  it('deduplicates identical content', async () => {
    const first = await store.put('same bytes')
    const second = await store.put('same bytes')
    expect(second).toEqual(first)
    expect(await store.has(first.digest)).toBe(true)
  })

  it('stores content sharded by digest prefix', async () => {
    const ref = await store.put('sharded')
    const hex = ref.digest.slice('sha256:'.length)
    const shard = await readdir(join(root, hex.slice(0, 2)))
    expect(shard).toContain(hex)
  })

  it('fails explicitly for missing artifacts', async () => {
    const missing = 'sha256:' + 'a'.repeat(64)
    await expect(store.get(missing)).rejects.toBeInstanceOf(
      ArtifactNotFoundError,
    )
    expect(await store.has(missing)).toBe(false)
  })

  it('rejects malformed digests', async () => {
    await expect(store.get('sha256:xyz')).rejects.toBeInstanceOf(
      InvalidArtifactDigestError,
    )
    await expect(store.get('md5:abc')).rejects.toBeInstanceOf(
      InvalidArtifactDigestError,
    )
  })
})
