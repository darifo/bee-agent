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
  'tool-command': ['knowledge', 'runtime'],
  'tool-mcp': ['knowledge', 'runtime'],
  'tool-python': ['knowledge', 'runtime'],
  client: ['thread'],
  'storage-sqlite': ['kanban', 'knowledge'],
  bee: [
    'kernel',
    'kanban',
    'knowledge',
    'model-providers',
    'runtime',
    'storage-sqlite',
    'thread',
    'tool-command',
    'tool-mcp',
    'tool-python',
  ],
}

const INTERNAL_PREFIX = '@bee-agent/'

const SPECIFIER_PATTERN =
  /(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(?\s*)['"]([^'"]+)['"]/g

const FORBIDDEN_RUNTIME_PACKAGES = new Set(['cordis', 'cosmokit'])
const PROCESS_SPAWN_MODULES = new Set(['child_process', 'node:child_process'])

export function extractImportSpecifiers(source) {
  return [...source.matchAll(SPECIFIER_PATTERN)].map((match) => match[1])
}

export function internalPackageName(specifier) {
  if (!specifier.startsWith(INTERNAL_PREFIX)) return undefined
  return specifier.slice(INTERNAL_PREFIX.length).split('/')[0]
}

/** Every internal import specifier referenced by a source file. */
export function extractInternalSpecifiers(source) {
  const found = []
  for (const specifier of extractImportSpecifiers(source)) {
    const name = internalPackageName(specifier)
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

  for (const specifier of extractImportSpecifiers(source.code)) {
    if (packageName !== 'execution' && PROCESS_SPAWN_MODULES.has(specifier)) {
      offenders.set(`spawn:${specifier}`, {
        packageName,
        imported: specifier,
        forbiddenSpawn: true,
      })
    }
    const root = specifier.split('/')[0]
    if (FORBIDDEN_RUNTIME_PACKAGES.has(root)) {
      offenders.set(`forbidden:${root}`, {
        packageName,
        imported: root,
        forbidden: true,
      })
    }
  }

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

  const targets = [
    ...packageDirs.map((packageName) => ({
      packageName,
      directory: join(rootDir, 'packages', packageName),
    })),
    { packageName: 'bee', directory: join(rootDir, 'apps', 'bee') },
    {
      packageName: 'storage-sqlite',
      directory: join(rootDir, 'adapters', 'storage', 'sqlite'),
    },
    {
      packageName: 'tool-command',
      directory: join(rootDir, 'adapters', 'tools', 'command'),
    },
    {
      packageName: 'tool-mcp',
      directory: join(rootDir, 'adapters', 'tools', 'mcp'),
    },
    {
      packageName: 'tool-python',
      directory: join(rootDir, 'adapters', 'tools', 'python'),
    },
  ]

  for (const { packageName, directory } of targets) {
    for (const area of ['src', 'tests']) {
      const areaDir = join(directory, area)
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

  // Spawn confinement is repository-wide, including apps/adapters that do not
  // participate in the internal package DAG above.
  for (const base of ['packages', 'apps', 'adapters', 'scripts']) {
    const directory = join(rootDir, base)
    let files
    try {
      files = await readdir(directory, { recursive: true, withFileTypes: true })
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.isFile() || !/\.(?:ts|js|mjs)$/.test(file.name)) continue
      const filePath = join(file.parentPath, file.name)
      const relativePath = relative(rootDir, filePath)
      if (
        relativePath.includes('/dist/') ||
        relativePath.includes('/node_modules/') ||
        relativePath.startsWith('packages/execution/')
      ) {
        continue
      }
      const code = await readFile(filePath, 'utf8')
      for (const specifier of extractImportSpecifiers(code)) {
        if (!PROCESS_SPAWN_MODULES.has(specifier)) continue
        violations.push({
          packageName: 'repository',
          imported: specifier,
          forbiddenSpawn: true,
          file: relativePath,
        })
      }
    }
  }
  return [
    ...new Map(
      violations.map((violation) => [
        `${violation.file}:${violation.imported}:${violation.forbiddenSpawn === true ? 'spawn' : 'boundary'}`,
        violation,
      ]),
    ).values(),
  ]
}

function formatViolation(violation) {
  if (violation.forbiddenSpawn) {
    return `${violation.file}: imports '${violation.imported}' outside @bee-agent/execution; route process creation through ExecutionWorld`
  }
  if (violation.forbidden) {
    return `${violation.file}: imports forbidden runtime package '${violation.imported}'; use @bee-agent/kernel`
  }
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
    const directory =
      packageName === 'bee'
        ? 'apps/bee'
        : packageName === 'storage-sqlite'
          ? 'adapters/storage/sqlite'
          : packageName === 'tool-command'
            ? 'adapters/tools/command'
            : `packages/${packageName}`
    return {
      files: [`${directory}/**/*.ts`],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths:
              packageName === 'execution'
                ? []
                : [
                    {
                      name: 'node:child_process',
                      message:
                        'Route process creation through @bee-agent/execution.',
                    },
                    {
                      name: 'child_process',
                      message:
                        'Route process creation through @bee-agent/execution.',
                    },
                  ],
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
