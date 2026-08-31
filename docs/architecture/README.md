# Architecture documents

User-facing docs live one level up: [`../user-guide.md`](../user-guide.md)
(usage) and [`../plugin-development.md`](../plugin-development.md)
(plugins). This directory separates the target architecture, executable development plan,
security model, and completed kernel research. The HTTP surface of the running
Host is documented in [`../api.md`](../api.md). For current implementation
status, read the documents in this order:

1. [`current-implementation-status.md`](./current-implementation-status.md) —
   source-aligned snapshot of implemented and pending capabilities.
2. [`bee-agent-v1.0.0-architecture-upgrade.md`](./bee-agent-v1.0.0-architecture-upgrade.md)
   — target architecture and design rationale.
3. [`bee-agent-v1.0.0-refactor-development-plan.md`](./bee-agent-v1.0.0-refactor-development-plan.md)
   — phase/task dependencies and rolling status.
4. [`kernel-opt-development-plan.md`](./kernel-opt-development-plan.md) —
   implemented Context–Registry–Fiber and StructureGeneration rules.
5. [`bee-agent-v1.0.0-threat-model.md`](./bee-agent-v1.0.0-threat-model.md)
   — security goals, implemented mitigations, and pending controls.

Historical research documents remain useful evidence but do not override the
implemented ADRs or current status:

- [`kernel-backing-spike-report.md`](./kernel-backing-spike-report.md)
- [`bee-agent-v1.0.0-kernel-core-cordis-parity.md`](./bee-agent-v1.0.0-kernel-core-cordis-parity.md)

When implementation changes, update the current-status page, affected plan
rows, relevant ADR status/consequences, and both root READMEs in the same
commit.
