# ADR 0005: Use pgvector for semantic memory

## Background

Server-mode semantic memory requires durable vector search with permission filtering.

## Decision

Use PostgreSQL with pgvector as the production vector adapter.

## Reasons

It keeps relational metadata, workspace filters, and vector operations in one transactional platform.

## Alternatives

A dedicated vector database or an embedded SQLite vector extension.

## Positive impact

Operational complexity is reduced for PostgreSQL deployments.

## Negative impact

Local SQLite mode will not have equivalent high-performance semantic search initially.

## Follow-up constraints

pgvector is an independent plugin, validates dimensions, and never bypasses workspace authorization.
