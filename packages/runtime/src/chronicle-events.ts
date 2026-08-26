import type { ChronicleSchemaRegistry } from '@bee-agent/knowledge'
import { registerExecutionChronicleEvents } from '@bee-agent/execution'
import { registerModelRequestChronicleEvents } from './model-request-service.ts'

/** Registers every Chronicle event owned by the runtime execution plane. */
export function registerRuntimeChronicleEvents(
  registry: ChronicleSchemaRegistry,
): void {
  if (!registry.has('model.requested')) {
    registerModelRequestChronicleEvents(registry)
  }
  if (!registry.has('execution.requested')) {
    registerExecutionChronicleEvents(registry)
  }
}
