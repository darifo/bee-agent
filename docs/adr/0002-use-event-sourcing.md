# ADR 0002: Use event sourcing for task history

## Background

Tasks must be traceable, resumable, and replayable.

## Decision

Persist task activity as immutable, append-only events with a monotonic per-task sequence.

## Reasons

An ordered event history supports audit, reconstruction, and live delivery from one model.

## Alternatives

Mutable task rows only, or unstructured application logs.

## Positive impact

Task state can be rebuilt and execution decisions remain inspectable.

## Negative impact

Schema evolution and projections require deliberate compatibility handling.

## Follow-up constraints

Events are never updated; sequence allocation must be transactional and state changes must be derivable from events.
