import type {
  MemoryClaim,
  MemoryContext,
  MemoryContextInput,
  MemoryConsolidationReport,
  MemoryDerivationInput,
  MemoryDerivationResult,
  MemoryExport,
  MemoryHealth,
  MemoryIngestInput,
  MemoryIngestResult,
  MemoryProvider,
  MemoryQuery,
  MemoryRepresentation,
} from '@bee-agent/knowledge'

/**
 * The memory bridge transport (v1 refactor plan §5.5 WF4-C): the only seam a
 * remote memory plugs into. An HTTP/MCP client implements these methods
 * against the remote service; the RemoteMemoryProvider adds health tracking
 * on top. Transports stay dumb — no caching, no fallback, no silent empty
 * results, so degradation is always observable.
 */
export interface MemoryBridgeTransport {
  ingest(input: MemoryIngestInput): Promise<MemoryIngestResult>
  query(query: MemoryQuery): Promise<readonly MemoryClaim[]>
  buildContext(input: MemoryContextInput): Promise<MemoryContext>
  getRepresentation(claimIds: readonly string[]): Promise<MemoryRepresentation>
  derive(input: MemoryDerivationInput): Promise<MemoryDerivationResult>
  consolidate(): Promise<MemoryConsolidationReport>
  retract(claimId: string, reason?: string): Promise<MemoryClaim>
  export(): Promise<MemoryExport>
  health(): Promise<MemoryHealth>
}

/**
 * The in-process SDK bridge: mounts any {@link MemoryProvider} behind the
 * transport seam. This is the reference wiring for embedding another
 * provider implementation without a network hop.
 */
export function createMemoryBridgeTransport(
  provider: MemoryProvider,
): MemoryBridgeTransport {
  return {
    ingest: (input) => provider.ingest(input),
    query: (query) => provider.query(query),
    buildContext: (input) => provider.buildContext(input),
    getRepresentation: (claimIds) => provider.getRepresentation(claimIds),
    derive: (input) => provider.derive(input),
    consolidate: () => provider.consolidate(),
    retract: (claimId, reason) =>
      provider.retract(claimId, reason === undefined ? undefined : reason),
    export: () => provider.export(),
    health: () => provider.health(),
  }
}
