# Adapters

External process and protocol adapters live here.

- `tools/command` declares the opt-in `command_run` tool. It validates the
  Host allowlist and workspace boundary, but never creates a process; execution
  belongs to `ExecutionWorld` and `PlatformCommandSandbox`.
- `tools/python` declares the opt-in `python_run` tool. It sends bounded JSON
  through declared command stdin to a fixed isolated interpreter; paths,
  approval, execution, cancellation, and output capture stay in ExecutionWorld.
- MCP, Codex, Claude Agent and DeepSeek adapters remain pending their
  ExecutionWorld migrations.
