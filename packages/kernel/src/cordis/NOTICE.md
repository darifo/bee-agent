# Vendored cordis

This directory vendors the cordis plugin runtime, MIT-licensed, originally by
Shigma (https://github.com/cordiverse/cordis), as republished and vendored by
the deepseek-harness project (`@deepseek-ai/cordis@4.0.1`,
`vendor/cordis`).

The port adapts the `@deepseek-ai/*` scope to `@bee-agent/*`, inlines the small
`cosmokit` subset it needs (`cosmokit.ts`), and inlines the Standard Schema v1
type (`standard-schema.ts`) instead of depending on `@standard-schema/spec`.

Each source file carries a `// @ts-nocheck` directive (vendored code, kept in
upstream form and not typechecked to Bee's stricter rules), and the directory
is excluded from Bee's stricter lint and prettier checks; the rest of
`@bee-agent/kernel` stays fully strict.

See ADR 0030 and `docs/architecture/kernel-backing-spike-report.md`.
