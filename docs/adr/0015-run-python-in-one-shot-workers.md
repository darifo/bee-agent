# ADR 0015: Run Python in one-shot workers

> Status: Replaced for v1 by `adapters/tools/python` and ADR 0034. The old
> direct-spawn implementation was deleted; the replacement declares one fixed
> interpreter command and bounded JSON stdin for ExecutionWorld to authorize and
> run through an enforcing sandbox provider.

## Background

Data-processing tasks often need Python; the tool pipeline so far only runs in-process JavaScript (calculator) or external MCP servers.

## Legacy decision (v0)

Add `plugins/tools/python`: a `tools.python` Tool that runs caller-supplied Python in a fresh one-shot child process per call. The payload (`{ code, args }`) arrives as JSON on stdin, the interpreter bootstrap exposes `args` to the code, `stdout` is the output (JSON text is parsed into structured results), and non-zero exits, stderr, timeouts, and oversized output become tool errors. The composition root enables it only when explicitly opted in (`pythonTool` option / `BEE_AGENT_ENABLE_PYTHON`).

## v1 replacement

`adapters/tools/python` exposes `python_run` only when the Host configures a
native interpreter, canonical workspace, explicit runtime read roots, and
resource bounds. The adapter declares bounded JSON stdin and cannot create a
process; ExecutionWorld authorizes the concrete request and PlatformSandbox
owns process creation, isolation, cancellation, and output capture.

## Reasons

A fresh process per call is the strongest crash and state isolation available without sandboxing infrastructure; the stdout contract is notebook-simple for models and humans; failures stay tool-scoped through the existing error mapping; and opt-in keeps the default surface free of arbitrary code execution.

## Alternatives

A persistent worker process (state leaks between calls, harder cleanup), in-process JS Python runtimes (no isolation), or container-per-call sandboxes (deployment-heavy for an engineering preview, the right next step for hostile multi-tenant use).

## Positive impact

Agents gain the entire Python data ecosystem behind one tool id; the policy engine can gate it like any tool (`tools.python` approvals); timeouts and output caps bound runaway code.

## Negative impact

The v0 implementation provided crash isolation but not a security sandbox. The
v1 replacement requires an enforcing platform provider, does not inherit the
Host environment, and denies network access; interpreter startup cost remains,
and only CPython with stdlib JSON is assumed.

## Follow-up constraints

The stdout/stderr contract stays stable so stronger worker implementations can
replace Seatbelt/bwrap behind the same SandboxProvider contract.
