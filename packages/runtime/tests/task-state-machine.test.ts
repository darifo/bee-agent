import { describe, expect, it } from 'vitest'
import {
  InvalidTaskTransitionError,
  TASK_STATE_TRANSITIONS,
  TERMINAL_TASK_STATES,
  assertTaskTransition,
  canTransitionTask,
  isTerminalTaskState,
} from '../src/index.ts'

describe('task state machine', () => {
  it('allows the documented transitions', () => {
    expect(TASK_STATE_TRANSITIONS.pending).toEqual(['running', 'cancelled'])
    expect(canTransitionTask('pending', 'running')).toBe(true)
    expect(canTransitionTask('running', 'waiting_approval')).toBe(true)
    expect(canTransitionTask('running', 'completed')).toBe(true)
    expect(canTransitionTask('running', 'failed')).toBe(true)
    expect(canTransitionTask('waiting_approval', 'running')).toBe(true)
    expect(canTransitionTask('waiting_approval', 'cancelled')).toBe(true)
  })

  it('rejects invalid transitions', () => {
    expect(canTransitionTask('pending', 'completed')).toBe(false)
    expect(canTransitionTask('pending', 'waiting_approval')).toBe(false)
    expect(canTransitionTask('completed', 'running')).toBe(false)
    expect(canTransitionTask('failed', 'running')).toBe(false)
    expect(canTransitionTask('cancelled', 'pending')).toBe(false)
    expect(canTransitionTask('waiting_approval', 'pending')).toBe(false)
  })

  it('treats completed, failed, and cancelled as terminal', () => {
    for (const state of TERMINAL_TASK_STATES) {
      expect(isTerminalTaskState(state)).toBe(true)
      expect(TASK_STATE_TRANSITIONS[state]).toEqual([])
    }
    expect(isTerminalTaskState('running')).toBe(false)
    expect(isTerminalTaskState('waiting_approval')).toBe(false)
  })

  it('throws InvalidTaskTransitionError from assertTaskTransition', () => {
    expect(() => assertTaskTransition('pending', 'completed')).toThrow(
      InvalidTaskTransitionError,
    )
    expect(() => assertTaskTransition('pending', 'completed')).toThrow(
      "Invalid task state transition 'pending' -> 'completed'",
    )
    expect(() => assertTaskTransition('running', 'failed')).not.toThrow()
  })
})
