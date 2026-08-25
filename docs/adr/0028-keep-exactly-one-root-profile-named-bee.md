# ADR 0028: Keep Exactly One Root Profile Named bee

## Background

Hermes and other agent harnesses organize capabilities under multiple Profiles that a user switches between (coding, research, writing), each with its own identity, memory, and configuration. The v1 research pass (§5.3, §14.2) concluded that Profile switching splits identity and memory and that a personal agent is better served by one continuous identity with capabilities resolved per task.

## Decision

Bee has exactly one fixed root Profile named `bee`. Capabilities are composed by a `Bundle` — model, prompt, context policy, memory view, skills, tools, permissions, sandbox, and budgets — resolved into an immutable `EffectiveStructure` with a content digest at startup, and recorded into Chronicle as `structure.resolved` events. Coding, research, writing, and co-work are Skills, Tools, Plugins, or Bundles resolved per task, never Profiles to switch between. The system provides no Profile creation, switching, inheritance, or multi-identity memory forking.

## Reasons

One Profile means the user always faces the same agent, the same memory, and the same continuous Thread, which is what "an agent that knows you over time" requires. A single named root also gives structure reproducibility: every Turn and Episode records its `structureVersion`, so a capability change can be replayed against the exact structure it ran under.

## Alternatives

Multiple user Profiles (fragments identity and memory across contexts); an anonymous/default structure with no named root (no stable handle to attach versioning and governance to); or per-task profile inheritance (reintroduces identity forking through the back door).

## Positive impact

Identity, memory, and configuration cannot fork; the bundle→EffectiveStructure→digest pipeline makes structure changes queryable and revertible; the `bee` root is the anchor every version and permission decision hangs off.

## Negative impact

Genuine multi-identity use cases (separate work vs. personal personas) are out of scope and will not be added; every capability variation must fit the Bundle model rather than a bespoke profile mechanism.

## Follow-up constraints

The bundle schema enforces the literal `bee` profile id and rejects any other value; structure changes create new versions in Chronicle rather than mutating in place; a Turn pins its `structureVersion` for its whole execution, so a replacement only affects later Turns.
