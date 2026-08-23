import { useState } from 'react'
import type { FormEvent } from 'react'

export interface TaskFormProps {
  disabled?: boolean
  onCreate(input: string, agentId: string): void
}

/** Creates pending tasks; the runtime starts them afterwards. */
export function TaskForm({ disabled, onCreate }: TaskFormProps) {
  const [input, setInput] = useState('')
  const [agentId, setAgentId] = useState('agent.mock')

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = input.trim()
    if (trimmed.length === 0 || disabled) return
    onCreate(trimmed, agentId)
    setInput('')
  }

  return (
    <form className="task-form" onSubmit={submit}>
      <label>
        input
        <textarea
          value={input}
          rows={2}
          placeholder="What should the agent do?"
          onChange={(change) => setInput(change.target.value)}
        />
      </label>
      <label>
        agent
        <input
          value={agentId}
          onChange={(change) => setAgentId(change.target.value)}
        />
      </label>
      <button type="submit" disabled={disabled || input.trim().length === 0}>
        Create task
      </button>
    </form>
  )
}
