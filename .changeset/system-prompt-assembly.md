---
'@bee-agent/runtime': minor
'@bee-agent/server': minor
---

System prompt assembly with cache discipline (benchmark-driven hardening pass, step 6): the model-visible request finally starts with a system message, and the context package's budget allocation is now on the live path.

- `@bee-agent/runtime`: new `system-prompt` module — `SystemPromptAssembler` joins prioritized sections (identity before instructions before environment) under a token budget via the context package's `allocateContextBudget`, protects sections that must survive, and produces a digest-verified manifest plus the omitted-section ids for audit. `AgentLoopOptions.systemPrompt` takes a plain string, a lazy provider, or an assembler; the loop resolves it once (memoized) and prepends the identical system message object to every generation, so the prefix stays byte-stable for provider caching. Dynamic context keeps flowing through the retrieve/plan hooks as late messages — the documented rule is that anything per-turn belongs there, never in the system message.
- `@bee-agent/server`: the Host ships a default Bee system prompt — identity, the declared-tool execution model, deny-by-default sandbox/approval awareness (including that a tool error is a reactable result and that resumed turns continue from recorded state), and durable-task guidance — factual to behavior that exists, overridable wholesale via `BEE_AGENT_SYSTEM_PROMPT`. The system message lands in request manifests as `instruction` sections, so request replay audits it like everything else.
- Covered by assembler unit tests (priority join, budget omission, memoization, determinism), AgentLoop integration tests (single resolution across generations, identical message object, assembler input), a recorded replay fixture pinning the system-first message order, and updated host composition/memory-outage assertions that now expect the leading system prompt.
