import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'

/** Resolves an absolute path and requires its target to exist. */
export function canonicalExistingPath(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`)
  try {
    return realpathSync(path)
  } catch {
    throw new Error(`${label} does not exist`)
  }
}

/** Canonicalizes and validates a native executable used by a tool adapter. */
export function canonicalNativeExecutable(path: string, label: string): string {
  const executable = canonicalExistingPath(path, label)
  const stat = statSync(executable)
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error(`${label} '${executable}' is not executable`)
  }
  const prefix = Buffer.alloc(2)
  const descriptor = openSync(executable, 'r')
  try {
    readSync(descriptor, prefix, 0, prefix.byteLength, 0)
  } finally {
    closeSync(descriptor)
  }
  if (prefix.toString() === '#!') {
    throw new Error(
      `${label} '${executable}' is an interpreter script; configure its native interpreter instead`,
    )
  }
  return executable
}

/** Canonicalizes an adapter workspace and requires an existing directory. */
export function canonicalWorkspaceRoot(path: string, label: string): string {
  const root = canonicalExistingPath(path, label)
  if (!statSync(root).isDirectory()) {
    throw new Error(`${label} must be a directory`)
  }
  return root
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    const parent = dirname(path)
    if (parent === path) return path
    return join(canonicalPath(parent), basename(path))
  }
}

/** Resolves existing symlinks and missing ancestors, then rejects root escape. */
export function resolveWorkspacePath(
  root: string,
  input: string,
  label: string,
): string {
  const candidate = canonicalPath(resolve(root, input))
  const fromRoot = relative(root, candidate)
  if (
    fromRoot === '..' ||
    fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error(`${label} escapes the configured workspace`)
  }
  return candidate
}
