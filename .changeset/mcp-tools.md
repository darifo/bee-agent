---
'@bee-agent/plugin-tool-mcp': minor
'@bee-agent/server': minor
---

Added MCP tool servers over the stdio bridge (ADR 0014).

- `@bee-agent/plugin-tool-mcp` (new): zero-dependency MCP client speaking newline-delimited JSON-RPC 2.0 over child-process stdio — `initialize` handshake (protocol 2024-11-05), request/response correlation with per-request timeouts, notifications ignored, child death fails pending calls with the stderr tail, and close terminates the child SIGTERM→SIGKILL. `McpToolsPlugin` discovers tools via `tools/list` at mount time and adapts each to the runtime `Tool` contract under `mcp.<server>.<tool>` ids; `isError` results become thrown tool errors so failures stay tool-scoped; single-text results unwrap to plain strings. `McpServerConfigSchema` is exported for composition roots.
- `@bee-agent/server`: `mcpServers` option (env `BEE_AGENT_MCP`, a validated JSON array) mounts one kernel-managed plugin per server and registers its tools into the task runtime, so policy interception, approvals, and event sourcing apply to MCP tools unchanged; children stop with the kernel.
- Verified end to end against the official `@modelcontextprotocol/server-filesystem` driven by DeepSeek: the model listed a directory and read a file through two real MCP tool calls.
