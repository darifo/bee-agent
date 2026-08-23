# Integration tests

Package-local task-loop coverage lives in `packages/runtime` (state machine,
event replay, policy approvals, cancellation) and
`plugins/tools/calculator`. Cross-package suites that compose the kernel,
runtime, storage plugins, and the future server begin with the server stage.
