# Adapters

External process and protocol adapters live here.

- `tools/command` declares the opt-in `command_run` tool. It validates the
  Host allowlist and workspace boundary, but never creates a process; execution
  belongs to `ExecutionWorld` and `PlatformCommandSandbox`.
- MCP, Python worker, Codex, Claude Agent and DeepSeek adapters remain pending
  their ExecutionWorld migrations.
