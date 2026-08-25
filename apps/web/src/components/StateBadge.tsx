import type { TaskState } from '@bee-agent/contracts'
import { STATE_LABELS } from '../format.ts'

export function StateBadge({ state }: { state: TaskState }) {
  return <span className={`badge badge-${state}`}>{STATE_LABELS[state]}</span>
}
