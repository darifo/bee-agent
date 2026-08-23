# ADR 0004: Support SQLite and PostgreSQL

## Background

Local single-user operation and long-running multi-user servers have different storage needs.

## Decision

Provide separate SQLite and PostgreSQL adapters behind the same domain contracts, with one dialect active per instance.

## Reasons

SQLite simplifies local deployment while PostgreSQL supports concurrency and production operation.

## Alternatives

PostgreSQL-only deployment, SQLite-only deployment, or dual writes.

## Positive impact

Runtime code remains portable and local development has minimal infrastructure.

## Negative impact

Two migrations and adapter contract suites must be maintained.

## Follow-up constraints

Never dual-write; dialect branching stays inside adapters; PostgreSQL implementation is deferred.
