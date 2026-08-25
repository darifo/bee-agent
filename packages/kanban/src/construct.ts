import { KanbanTaskSchema } from './protocol.ts'
import type {
  KanbanBudget,
  KanbanDependency,
  KanbanPriority,
  KanbanSource,
  KanbanTask,
  KanbanTaskId,
  KanbanWorkspace,
} from './protocol.ts'

export interface NewKanbanTaskInit {
  readonly title: string
  readonly priority?: KanbanPriority | undefined
  readonly goal?: string | undefined
  readonly acceptanceCriteria?: readonly string[] | undefined
  readonly labels?: readonly string[] | undefined
  readonly dependencies?: readonly KanbanDependency[] | undefined
  readonly source?: KanbanSource | undefined
  readonly workspace?: KanbanWorkspace | undefined
  readonly requiredCapabilities?: readonly string[] | undefined
  readonly budget?: KanbanBudget | undefined
  readonly scheduledAt?: string | undefined
  readonly deadline?: string | undefined
  readonly idempotencyKey?: string | undefined
  readonly id?: KanbanTaskId | undefined
  readonly now?: string | undefined
}

/** Builds a new task in `inbox` at version 1 with empty collections. */
export function newKanbanTask(init: NewKanbanTaskInit): KanbanTask {
  const now = init.now ?? new Date().toISOString()
  return KanbanTaskSchema.parse({
    id: init.id ?? crypto.randomUUID(),
    title: init.title,
    goal: init.goal,
    acceptanceCriteria: [...(init.acceptanceCriteria ?? [])],
    priority: init.priority ?? 'medium',
    labels: [...(init.labels ?? [])],
    dependencies: [...(init.dependencies ?? [])],
    source: init.source,
    workspace: init.workspace,
    requiredCapabilities: [...(init.requiredCapabilities ?? [])],
    budget: init.budget,
    scheduledAt: init.scheduledAt,
    deadline: init.deadline,
    idempotencyKey: init.idempotencyKey,
    status: 'inbox',
    claim: undefined,
    artifactRefs: [],
    trajectoryRefs: [],
    comments: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
  })
}
