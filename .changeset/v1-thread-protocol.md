---
'@bee-agent/thread': minor
---

Land the Thread–Turn–Item protocol and its Chronicle integration. `@bee-agent/thread/protocol` is the dependency-free client surface (zod only, no cordis): Thread/Turn/Item zod contracts with the architecture's eight item types (message, plan, tool call, approval, artifact, file change, memory citation, learning note) paired to their payloads by a discriminated union, plus the wire event union (`thread.created`, `turn.started/completed/failed`, `item.started/delta/completed/failed`) and page types. The package root adds model constructors, Chronicle event builders (scope ids and turn structureVersion on the envelope), a `thread:<id>` stream convention, and `readThreadEvents` implementing `after` recovery with limit paging over any ChronicleStore — sequences are contiguous per thread, so reconnecting clients resume from their last seen sequence without gaps.
