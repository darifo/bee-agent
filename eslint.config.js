import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

import { getEslintBoundaryConfigs } from './scripts/check-package-boundaries.mjs'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '.zcode/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node scripts (MCP server fixtures and friends).
    files: ['**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { jsx: true },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
    },
  },
  // Workspace dependency boundaries (refactor plan §3.3); the authoritative
  // scanner runs alongside lint via `pnpm lint`.
  ...getEslintBoundaryConfigs(),
)
