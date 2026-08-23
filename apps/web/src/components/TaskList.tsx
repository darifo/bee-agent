import type { TaskSnapshot } from '@bee-agent/runtime'
import { StateBadge } from './StateBadge.js'
import { taskSummary } from '../format.js'

export interface TaskListProps {
  tasks: readonly TaskSnapshot[]
  selectedTaskId: string | null
  onSelect(taskId: string): void
}

export function TaskList({ tasks, selectedTaskId, onSelect }: TaskListProps) {
  if (tasks.length === 0) {
    return <p className="empty">No tasks yet. Create one to get started.</p>
  }
  return (
    <ul className="task-list">
      {tasks.map((task) => (
        <li key={task.taskId}>
          <button
            type="button"
            className={
              task.taskId === selectedTaskId
                ? 'task-row task-row-selected'
                : 'task-row'
            }
            onClick={() => onSelect(task.taskId)}
          >
            <StateBadge state={task.state} />
            <span className="task-row-body">
              <span className="task-row-summary">{taskSummary(task)}</span>
              <span className="task-row-id">{task.taskId}</span>
            </span>
            <span className="task-row-meta">#{task.lastSequence}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
