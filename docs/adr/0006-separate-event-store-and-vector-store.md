# ADR 0006: Separate Event Store and Vector Store

## Background

Audit events and derived embeddings have different lifecycles, query patterns, and compatibility rules.

## Decision

Expose independent Event Store and Vector Store interfaces and persist their records separately.

## Reasons

Task history must remain durable even when embeddings are regenerated or models change.

## Alternatives

Store vectors directly in event records or use one repository abstraction for both.

## Positive impact

Embedding maintenance cannot corrupt or couple itself to task replay.

## Negative impact

Memory ingestion must coordinate two stores and tolerate eventual derivation.

## Follow-up constraints

Vectors never enter event tables; every vector record identifies an embedding space.
