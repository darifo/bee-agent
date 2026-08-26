# CLI

Commander-based v1 client for the Personal Bee Host, built on
`@bee-agent/client`.

```bash
pnpm --filter @bee-agent/cli build

export BEE_AGENT_URL='http://127.0.0.1:3000'
export BEE_AGENT_SESSION_TOKEN='local-development-token'

pnpm --filter @bee-agent/cli bee -- chat
pnpm --filter @bee-agent/cli bee -- thread create --title 'Research'

pnpm --filter @bee-agent/cli bee -- kanban create --title 'Investigate issue'
pnpm --filter @bee-agent/cli bee -- kanban list
pnpm --filter @bee-agent/cli bee -- kanban show <taskId>
pnpm --filter @bee-agent/cli bee -- kanban update <taskId> --priority high
pnpm --filter @bee-agent/cli bee -- kanban block <taskId> --reason 'waiting'
pnpm --filter @bee-agent/cli bee -- kanban comment <taskId> 'note'
pnpm --filter @bee-agent/cli bee -- kanban complete <taskId>
pnpm --filter @bee-agent/cli bee -- kanban cancel <taskId>
```

`bee chat` creates one Thread and sends each line as a Turn. Approval prompts
are resolved interactively and the Turn resumes through the same durable
approval boundary. `/exit` or `/quit` closes the session.
