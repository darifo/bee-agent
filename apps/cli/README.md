# CLI

Commander-based command line client for the Bee Agent server, built on
`@bee-agent/client`.

```bash
pnpm --filter @bee-agent/cli build

# Point the CLI at a server (or export BEE_AGENT_URL)
export BEE_AGENT_URL=http://127.0.0.1:3000

bee task create -i "compute 1 + 2 * 3"      # prints the task id
bee task run <taskId>                       # starts and streams until done
bee task get <taskId>                       # prints the snapshot
bee task events <taskId> --after 2          # lists recorded events
bee task cancel <taskId> -r "not needed"
bee task watch <taskId>                     # streams without starting

bee approval list [-t <taskId>]             # pending approvals
bee approval decide <requestId> --approve [-r "go ahead"]
bee approval decide <requestId> --deny
```

Run the built CLI without a global install via
`pnpm --filter @bee-agent/cli bee -- task run <taskId>`. `task run` streams
`agent.message`, tool, and approval events over SSE while the task executes,
then exits: 0 for `completed`, 1 for `failed`, 2 for `cancelled`. Tasks
suspended in `waiting_approval` keep streaming, so an approval decided from
another terminal resumes them live.
