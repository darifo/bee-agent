# ADR 0008: Use independent package versioning

## Background

Core packages, adapters, and plugins evolve at different rates.

## Decision

Use pnpm workspaces and Changesets with independent package versions; plugins declare a Plugin API range.

## Reasons

Compatibility should follow public boundaries instead of the server's release number.

## Alternatives

One lockstep monorepo version or unpublished internal modules.

## Positive impact

Plugins can release independently with explicit compatibility diagnostics.

## Negative impact

Dependency updates and changelogs require package-level discipline.

## Follow-up constraints

No cross-package `src` imports; public imports use package exports and compatibility checks use `pluginApi`.
