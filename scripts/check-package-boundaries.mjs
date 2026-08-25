// Single source of truth for workspace package dependency boundaries.
//
// The v1 target DAG comes from the refactor development plan §3.3. Both
// eslint (editor + `pnpm lint`) and the CLI scanner below consume this
// module, so the rules can never drift apart.

export const V1_PACKAGE_DEPENDENCIES = {
  kernel: [],
  storage: [],
  knowledge: ['kernel', 'storage'],
  thread: ['kernel', 'knowledge'],
  kanban: ['kernel', 'knowledge'],
  execution: ['kernel', 'knowledge'],
  context: ['kernel', 'thread', 'knowledge', 'execution'],
  runtime: ['kernel', 'thread', 'kanban', 'context', 'knowledge', 'execution'],
  learning: ['kernel', 'knowledge', 'runtime', 'context'],
  'model-providers': ['runtime'],
  client: ['thread'],
}

const INTERNAL_PREFIX = '@bee-agent/'

const SPECIFIER_PATTERN =
  /(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(?\s*)['"]([^'"]+)['"]/g

export function internalPackageName(specifier) {
  if (!specifier.startsWith(INTERNAL_PREFIX)) return undefined
  return specifier.slice(INTERNAL_PREFIX.length).split('/')[0]
}

/** Every internal import specifier referenced by a source file. */
export function extractInternalSpecifiers(source) {
  const found = []
  for (const match of source.matchAll(SPECIFIER_PATTERN)) {
    const name = internalPackageName(match[1])
    if (name !== undefined) found.push(name)
  }
  return found
}

export function knownInternalPackages() {
  return [...new Set(Object.keys(V1_PACKAGE_DEPENDENCIES))]
}

export function allowedInternalImports(packageName) {
  return new Set(V1_PACKAGE_DEPENDENCIES[packageName] ?? [])
}

/**
 * Check one source file's content against the boundary rules. Returns a
 * violation list: `{ packageName, imports, allowed }` per offending internal
 * package name, plus `unknown` entries for names outside the workspace.
 */
export function checkSource(source) {
  const packageName = source.packageName
  const allowed = allowedInternalImports(packageName)
  const known = new Set(knownInternalPackages())
  const offenders = new Map()

  for (const imported of extractInternalSpecifiers(source.code)) {
    const isSelf = imported === packageName
    const isAllowed = allowed.has(imported)
    if (!isSelf && isAllowed) continue
    const key = known.has(imported) ? imported : `unknown:${imported}`
    if (!offenders.has(key))
      offenders.set(key, {
        packageName,
        imported,
        unknown: !known.has(imported),
      })
  }

  return [...offenders.values()]
}

async function scanWorkspace(rootDir) {
  const { readdir, readFile } = await import('node:fs/promises')
  const { join, relative } = await import('node:path')

  const violations = []
  const packageDirs = (
    await readdir(join(rootDir, 'packages'), { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  for (const packageName of packageDirs) {
    for (const area of ['src', 'tests']) {
      const areaDir = join(rootDir, 'packages', packageName, area)
      let files
      try {
        files = await readdir(areaDir, { recursive: true, withFileTypes: true })
      } catch {
        continue
      }
      for (const file of files) {
        if (!file.isFile() || !/\.ts$/.test(file.name)) continue
        const filePath = join(file.parentPath, file.name)
        const code = await readFile(filePath, 'utf8')
        for (const violation of checkSource({ packageName, code })) {
          violations.push({ ...violation, file: relative(rootDir, filePath) })
        }
      }
    }
  }
  return violations
}

function formatViolation(violation) {
  const rule = violation.unknown
    ? 'not a known workspace package'
    : 'outside its allowed dependencies'
  return `${violation.file}: ${violation.packageName} imports @bee-agent/${violation.imported} (${rule})`
}

export function getEslintBoundaryConfigs() {
  return knownInternalPackages().map((packageName) => {
    const allowed = allowedInternalImports(packageName)
    const disallowed = knownInternalPackages().filter(
      (name) => name !== packageName && !allowed.has(name),
    )
    const group = disallowed.flatMap((name) => [
      `${INTERNAL_PREFIX}${name}`,
      `${INTERNAL_PREFIX}${name}/*`,
    ])
    return {
      files: [`packages/${packageName}/**/*.ts`],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group,
                message: `@bee-agent/${packageName} may only import ${[...allowed].sort().join(', ') || 'no internal packages'} (refactor plan §3.3).`,
              },
            ],
          },
        ],
      },
    }
  })
}

if (
  process.argv[1] &&
  process.argv[1].endsWith('check-package-boundaries.mjs')
) {
  const rootDir = new URL('..', import.meta.url).pathname
  const violations = await scanWorkspace(rootDir)
  if (violations.length > 0) {
    for (const violation of violations)
      console.error(formatViolation(violation))
    process.exit(1)
  }
  console.log('package boundaries: ok')
}
