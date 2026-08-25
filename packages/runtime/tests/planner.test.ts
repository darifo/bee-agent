import { describe, expect, it } from 'vitest'
import { MemoryGoalPlanStore } from '../src/goal-plan-store.ts'
import { classifyTaskComplexity, createGoalPlanHook } from '../src/planner.ts'
import type { AgentLoopHookInput } from '../src/agent-loop.ts'

const THREAD = '11111111-1111-4111-8111-111111111111'
const TURN = '22222222-2222-4222-8222-222222222222'
const NOW = '2026-08-25T10:00:00.000Z'

function hookInput(input: string, stepIndex = 0): AgentLoopHookInput {
  return { threadId: THREAD, turnId: TURN, input, history: [], stepIndex }
}

describe('classifyTaskComplexity', () => {
  it('treats short questions and trivial commands as simple', () => {
    expect(classifyTaskComplexity("What's the capital of France?")).toBe(
      'simple',
    )
    expect(classifyTaskComplexity('Summarize this note.')).toBe('simple')
    expect(classifyTaskComplexity('')).toBe('simple')
  })

  it('treats multi-sentence, multi-step, and project requests as complex', () => {
    expect(
      classifyTaskComplexity('Plan a trip to Tokyo. Then book the flights.'),
    ).toBe('complex')
    expect(
      classifyTaskComplexity(
        'Build a CLI tool that converts markdown to HTML.',
      ),
    ).toBe('complex')
    expect(
      classifyTaskComplexity(
        'First gather the data, then write the report, finally present it.',
      ),
    ).toBe('complex')
  })
})

describe('goal/plan hook', () => {
  it('produces nothing for simple Q&A (zero ceremony)', async () => {
    const store = new MemoryGoalPlanStore()
    const hook = createGoalPlanHook(store, { now: () => NOW })

    expect(await hook.plan(hookInput('What is 2+2?'))).toEqual([])
    expect(await store.getGoal(THREAD)).toBeUndefined()
  })

  it('creates a queryable goal and versioned plan DAG for a complex task', async () => {
    const store = new MemoryGoalPlanStore()
    const hook = createGoalPlanHook(store, { now: () => NOW })
    const messages = await hook.plan(
      hookInput('Build a CLI tool that converts markdown to HTML.'),
    )

    expect(messages).toHaveLength(1)
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toContain('Goal:')

    const goal = await store.getGoal(THREAD)
    expect(goal?.statement).toBe(
      'Build a CLI tool that converts markdown to HTML.',
    )
    const plans = await store.listPlans(goal!.id)
    expect(plans).toHaveLength(1)
    expect(plans[0]?.version).toBe(1)
    expect(plans[0]?.steps.map((step) => step.id)).toEqual([
      'scope',
      'execute',
      'verify',
    ])
    expect(plans[0]?.steps[1]?.dependsOn).toEqual(['scope'])
  })

  it('appends a new plan version on a repeated complex turn and skips later steps', async () => {
    const store = new MemoryGoalPlanStore()
    const hook = createGoalPlanHook(store, { now: () => NOW })

    await hook.plan(hookInput('Build a CLI tool.'))
    await hook.plan(hookInput('Also add support for PDF output.'))

    const goal = await store.getGoal(THREAD)
    const plans = await store.listPlans(goal!.id)
    expect(plans.map((plan) => plan.version)).toEqual([1, 2])
    expect(plans[1]?.revisionReason).toBeDefined()

    // Later steps in the same turn do not re-plan.
    expect(await hook.plan(hookInput('Build a CLI tool.', 1))).toEqual([])
  })
})
