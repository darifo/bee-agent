# ADR 0012: Ride memory chunks on embedding records

## Background

Semantic memory needs chunk text at recall time, but the Vector Store contract stores vectors and metadata only, and ADR 0006 keeps vectors out of the event store — leaving nowhere obvious for documents to live.

## Decision

Store each memory chunk as an embedding record whose metadata carries the full chunk payload under a reserved top-level `chunk` key, alongside the document's own metadata keys. Documents are chunked on word boundaries, embedded by a pluggable `Embedder` whose declared embedding space owns every record, and recalled by embedding the query in the same space. No separate document registry exists yet.

## Reasons

It keeps memory self-contained in the Vector Store (one transactional platform per ADR 0005), preserves JSONB metadata filters over user keys, and makes embedder switches safe: a new embedder is a new embedding space, so old records stay intact instead of being corrupted by mixed vectors.

## Alternatives

A dedicated document store (extra migration, dual writes), chunk text inside task events (couples memory lifecycle to replay and violates ADR 0006), or a second query API on the Vector Store just for content.

## Positive impact

Recall rebuilds chunks without joins or a second store; workspace authorization stays the Vector Store's single scoping rule; listing and migrating documents remains possible later by adding a registry without changing stored records.

## Negative impact

`chunk` becomes a reserved metadata key; documents cannot be enumerated or bulk-deleted until a registry arrives; chunk payloads inflate vector rows.

## Follow-up constraints

Real model providers replace the deterministic `MockEmbedder` behind the same `Embedder` contract; a document registry may be added but must read the existing record shape.
