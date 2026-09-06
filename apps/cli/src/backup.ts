import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * `bee backup` (data ownership, architecture §16.1): the SQLite database
 * plus sidecars compress into one archive with a checksum. Local-first
 * means the user owns durability — this is the one-command safety net.
 */

export interface BackupResult {
  readonly archive: string
  readonly checksum: string
  readonly bytes: number
  readonly files: readonly string[]
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk as Buffer))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

export async function backupDataDir(input: {
  readonly dataDir: string
  readonly outDir: string
  readonly keep?: number | undefined
}): Promise<BackupResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  await mkdir(input.outDir, { recursive: true })
  const workDir = join(input.outDir, `.bee-backup-${stamp}`)
  await mkdir(workDir, { recursive: true })

  // Only the SQLite database and its WAL/SHM sidecars matter; anything
  // else in the data dir is derivable or transient.
  const entries = await readdir(input.dataDir)
  const files: string[] = []
  for (const name of entries) {
    if (!/\.(sqlite|sqlite-wal|sqlite-shm)$/.test(name)) continue
    const source = join(input.dataDir, name)
    const info = await stat(source)
    if (!info.isFile()) continue
    // Copy, don't move: the host may be live. SQLite readers see a
    // consistent snapshot as long as each file copies atomically.
    await copyFile(source, join(workDir, name))
    files.push(name)
  }
  if (!files.some((file) => file.endsWith('.sqlite'))) {
    throw new Error(`no SQLite database found in '${input.dataDir}'`)
  }

  const manifest = JSON.stringify(
    { createdAt: new Date().toISOString(), files },
    null,
    2,
  )
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(workDir, 'manifest.json'), manifest)

  const archive = join(input.outDir, `bee-backup-${stamp}.tar.gz`)
  // tar via child process: zero new dependencies, universally present.
  const { execFile } = await import('node:child_process')
  await new Promise<void>((resolve, reject) => {
    execFile(
      'tar',
      ['-czf', archive, '-C', input.outDir, `.bee-backup-${stamp}`],
      (error) => (error === null ? resolve() : reject(error)),
    )
  })

  const checksum = await sha256File(archive)
  const { writeFile: writeSha } = await import('node:fs/promises')
  await writeSha(
    `${archive}.sha256`,
    `${checksum}  bee-backup-${stamp}.tar.gz\n`,
  )
  const bytes = (await stat(archive)).size

  // cleanup the staging directory
  const { rm } = await import('node:fs/promises')
  await rm(workDir, { recursive: true, force: true })

  // retention: keep the newest N archives
  if (input.keep !== undefined && input.keep > 0) {
    const all = (await readdir(input.outDir))
      .filter((name) => /^bee-backup-\d{4}-\d{2}-\d{2}T.*\.tar\.gz$/.test(name))
      .sort()
      .reverse()
    for (const stale of all.slice(input.keep)) {
      await rm(join(input.outDir, stale), { force: true })
      await rm(`${join(input.outDir, stale)}.sha256`, { force: true })
    }
  }

  return { archive, checksum, bytes, files }
}
