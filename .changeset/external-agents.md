---
'@bee-agent/agent-adapters': minor
'@bee-agent/server': minor
---

Added external agents behind the Agent contract (ADR 0016) — the roadmap's final milestone.

- `@bee-agent/agent-adapters` (new, in `adapters/agents`): `RemoteAgent` federates a run to another Bee Agent server over the Client SDK — it creates the remote task, triggers the run, mirrors remote `agent.message` events into the local event log once the stream closes, propagates local cancellation to the remote task, and returns the remote result as its output. `CommandAgent` wraps any executable behind the same contract: `{input}` argv placeholders (or stdin via `inputVia`) carry the task input, stdout becomes the reply, with per-run timeouts, env control, and stderr/exit-code error mapping; `CommandAgentConfigSchema` is exported and validates both shape and defaults.
- `@bee-agent/server`: `agents` option registers adapters under their own agent ids at startup; env `BEE_AGENT_COMMAND_AGENTS` (a validated JSON array) configures command agents from the entrypoint.
- Federation is verified end to end against an in-process server pair (mirrored messages, completed snapshots) and command agents against real executables (argv, stdin, failures, timeouts).
