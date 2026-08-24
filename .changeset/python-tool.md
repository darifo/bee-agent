---
'@bee-agent/plugin-tool-python': minor
'@bee-agent/server': minor
---

Added the opt-in Python worker tool (ADR 0015).

- `@bee-agent/plugin-tool-python` (new): `tools.python` runs caller-supplied Python in a fresh one-shot child process per call — the `{ code, args }` payload arrives as JSON on stdin, the embedded bootstrap exposes `args` to the code, stdout is the output (JSON text is parsed into structured results), and non-zero exits, stderr, wall-clock timeouts (default 10s), and output caps (default 1 MiB) all become tool errors. Fresh processes per call give crash and state isolation without sandboxing infrastructure; this is explicitly not a security sandbox.
- `@bee-agent/server`: `pythonTool` option (`true` or tuned `{ command, timeoutMs, maxOutputBytes }`) adds the tool to the default set — never without opt-in; env `BEE_AGENT_ENABLE_PYTHON=1` flips it from the entrypoint. Explicit `tools` still replace the whole set.
