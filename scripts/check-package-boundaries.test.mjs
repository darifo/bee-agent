import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  V1_PACKAGE_DEPENDENCIES,
  allowedInternalImports,
  checkSource,
  extractInternalSpecifiers,
  internalPackageName,
  knownInternalPackages,
} from './check-package-boundaries.mjs'

test('internalPackageName maps specifiers and subpaths to package names', () => {
  assert.equal(internalPackageName('@bee-agent/kernel'), 'kernel')
  assert.equal(internalPackageName('@bee-agent/kernel/testing'), 'kernel')
  assert.equal(internalPackageName('zod'), undefined)
  assert.equal(internalPackageName('cordis'), undefined)
  assert.equal(internalPackageName('node:fs'), undefined)
  assert.equal(internalPackageName('./relative.js'), undefined)
  assert.equal(internalPackageName('@types/node'), undefined)
})

test('extractInternalSpecifiers finds static, type-only, side-effect, and dynamic imports', () => {
  const source = [
    "import { Kernel } from '@bee-agent/kernel'",
    "import type { Foo } from '@bee-agent/thread'",
    "import '@bee-agent/plugin-sdk'",
    "const mod = await import('@bee-agent/knowledge')",
    "export { X } from '@bee-agent/execution'",
    "import { z } from 'zod'",
    "import { join } from 'node:path'",
  ].join('\n')
  assert.deepEqual(extractInternalSpecifiers(source).sort(), [
    'execution',
    'kernel',
    'knowledge',
    'plugin-sdk',
    'thread',
  ])
})

test('v1 boundaries stay acyclic and reference known packages only', () => {
  const known = new Set(knownInternalPackages())
  for (const [packageName, dependencies] of Object.entries(
    V1_PACKAGE_DEPENDENCIES,
  )) {
    assert.ok(known.has(packageName), `${packageName} is a known package`)
    for (const dependency of dependencies) {
      assert.ok(
        known.has(dependency),
        `${packageName} -> ${dependency} references a known package`,
      )
      assert.notEqual(
        dependency,
        packageName,
        `${packageName} must not depend on itself`,
      )
    }
  }
})

test('checkSource allows dependencies inside the v1 DAG', () => {
  const violations = checkSource({
    packageName: 'runtime',
    code: [
      "import { Kernel } from '@bee-agent/kernel'",
      "import { ThreadId } from '@bee-agent/thread'",
      "import { ChronicleStore } from '@bee-agent/knowledge'",
    ].join('\n'),
  })
  assert.deepEqual(violations, [])
})

test('checkSource flags imports outside the allowed set', () => {
  const violations = checkSource({
    packageName: 'thread',
    code: "import { Runtime } from '@bee-agent/runtime'",
  })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].imported, 'runtime')
  assert.equal(violations[0].packageName, 'thread')
})

test('checkSource flags self-imports and unknown workspace names', () => {
  const violations = checkSource({
    packageName: 'kernel',
    code: [
      "import { X } from '@bee-agent/kernel'",
      "import { Y } from '@bee-agent/nonexistent'",
    ].join('\n'),
  })
  assert.equal(violations.length, 2)
  assert.ok(violations.some((violation) => violation.imported === 'kernel'))
  assert.ok(violations.some((violation) => violation.unknown))
})

test('allowedInternalImports reflects the v1 dependency DAG', () => {
  assert.deepEqual([...allowedInternalImports('runtime')].sort(), [
    'context',
    'execution',
    'kanban',
    'kernel',
    'knowledge',
    'thread',
  ])
  assert.deepEqual(
    allowedInternalImports('thread'),
    new Set(['kernel', 'knowledge']),
  )
  assert.deepEqual(allowedInternalImports('client'), new Set(['thread']))
})
