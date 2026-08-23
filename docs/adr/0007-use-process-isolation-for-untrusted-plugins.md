# ADR 0007: Isolate untrusted plugins in processes

## Background

Third-party and generated capabilities may handle untrusted code or data.

## Decision

Prefer supervised external processes for high-risk capabilities instead of loading them into the server process.

## Reasons

Process boundaries allow timeouts, termination, environment restriction, and clearer fault containment.

## Alternatives

Load every plugin in-process or split every capability into a network service.

## Positive impact

Crashes and runaway resources are easier to contain.

## Negative impact

Serialization, startup, and supervision add complexity and latency.

## Follow-up constraints

External processes use explicit protocols and limits; generated code is never loaded directly by the server.
