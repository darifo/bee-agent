# ADR 0001: Use TypeScript and Cordis

## Background

The platform needs typed module boundaries and deterministic resource lifecycles.

## Decision

Use Node.js 22, strict TypeScript, and Cordis for contexts, scopes, effects, services, and plugin lifecycle.

## Reasons

They provide a shared language across clients and server plus explicit lifecycle primitives.

## Alternatives

A custom dependency-injection kernel or a framework-specific application container.

## Positive impact

Plugins share typed, testable lifecycle conventions and task resources can be scoped.

## Negative impact

The team must track Cordis APIs and isolate framework-specific behavior in `packages/kernel`.

## Follow-up constraints

Core business packages must not depend on Cordis directly; record meaningful API differences after upgrades.
