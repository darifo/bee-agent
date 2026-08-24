# ADR 0014: Expose MCP servers as tools

## Background

The tool pipeline is local (calculator); real deployments need the broader MCP ecosystem of external tool servers.

## Decision

Add `plugins/tools/mcp`: a hand-rolled, zero-dependency MCP client over the stdio transport (newline-delimited JSON-RPC 2.0) that spawns each configured server as its own child process, completes the `initialize` handshake, discovers tools via `tools/list`, and adapts them to the runtime `Tool` contract under `mcp.<server>.<tool>` ids. The composition root mounts servers from `BEE_AGENT_MCP` (a JSON array validated by the exported `McpServerConfigSchema`) and registers the discovered tools into the task runtime.

## Reasons

Child processes are exactly the isolation boundary ADR 0007 asks for; the runtime's policy engine, approval suspension, and event sourcing keep working because MCP tools are ordinary `Tool`s; `isError` results become thrown tool errors so failures stay tool-scoped; the JSON-RPC surface needed for `initialize`/`tools/list`/`tools/call` is small enough to avoid an SDK dependency.

## Alternatives

The official `@modelcontextprotocol/sdk` (dependency weight, version churn), HTTP/SSE transports first (more moving parts before value), or mapping MCP servers to kernel services (tools belong to the task runtime, not the service catalog).

## Positive impact

Any stdio MCP server works with no code changes; server death surfaces as rejected tool calls with the child's stderr tail; the kernel lifecycle terminates children with SIGTERM→SIGKILL.

## Negative impact

Only the stdio transport and the tools capability are covered (resources and prompts are out of scope); one process per server; no auth handshake for remote transports yet.

## Follow-up constraints

Remote transports extend `McpClient` behind the same interface; MCP tool ids stay namespaced so policies can target them (`mcp.<server>.*`).
