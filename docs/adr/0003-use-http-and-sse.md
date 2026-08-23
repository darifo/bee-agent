# ADR 0003: Use HTTP and SSE

## Background

CLI and Web clients need commands plus real-time task events.

## Decision

Use REST over HTTP for commands and Server-Sent Events for the first streaming transport.

## Reasons

SSE is sufficient for server-to-client traces and keeps the initial protocol small.

## Alternatives

WebSocket, polling, or a bidirectional RPC transport.

## Positive impact

Clients use standard HTTP infrastructure and simple reconnection semantics.

## Negative impact

Client-to-server streaming and arbitrary bidirectional messages are not supported.

## Follow-up constraints

Clients access runtime behavior only through the Client SDK; do not add WebSocket in the first phase.
