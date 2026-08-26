# ADR 0014: Expose MCP servers as tools

> Status: Replaced for v1 by `adapters/tools/mcp` and ADR 0034. The old
> direct-spawn client was deleted; the replacement pins discovery output in a
> Host manifest and executes each stdio session through ExecutionWorld.

## Background

The tool pipeline is local (calculator); real deployments need the broader MCP ecosystem of external tool servers.

## Legacy decision (v0)

Add `plugins/tools/mcp`: a hand-rolled, zero-dependency MCP client over the stdio transport (newline-delimited JSON-RPC 2.0) that spawns each configured server as its own child process, completes the `initialize` handshake, discovers tools via `tools/list`, and adapts them to the runtime `Tool` contract under `mcp.<server>.<tool>` ids. The composition root mounts servers from `BEE_AGENT_MCP` (a JSON array validated by the exported `McpServerConfigSchema`) and registers the discovered tools into the task runtime.

## v1 replacement

`BEE_AGENT_MCP_MANIFESTS` supplies the protocol version and pinned tool
schemas. Adapters emit `mcp__<server>__<tool>` specs and staged JSON-lines stdio
requirements. PlatformSandbox starts the native executable, waits for the
initialize response, sends the initialized notification and tool call, then
terminates the process group after the matching response. Adapter-side process
creation and implicit startup discovery are forbidden.

## Reasons

Child processes are exactly the isolation boundary ADR 0007 asks for; the runtime's policy engine, approval suspension, and event sourcing keep working because MCP tools are ordinary `Tool`s; `isError` results become thrown tool errors so failures stay tool-scoped; the JSON-RPC surface needed for `initialize`/`tools/list`/`tools/call` is small enough to avoid an SDK dependency.

## Alternatives

The official `@modelcontextprotocol/sdk` (dependency weight, version churn), HTTP/SSE transports first (more moving parts before value), or mapping MCP servers to kernel services (tools belong to the task runtime, not the service catalog).

## Positive impact

Networkless stdio MCP servers work behind the same authorization, event,
cancellation, output-bound and sandbox pipeline as other external tools.

## Negative impact

Only JSON-lines stdio tools are covered; resources, prompts, dynamic discovery,
networked servers, and remote transports remain out of scope. A fresh process
and initialize handshake are paid per tool call.

## Follow-up constraints

Dynamic discovery must become a separately authorized lifecycle action that
produces a reviewable manifest. Remote transports require an enforcing network
provider. Tool ids stay namespaced as `mcp__<server>__<tool>`.
