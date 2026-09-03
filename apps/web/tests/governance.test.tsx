import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type {
  BeeAgentClient,
  MemoryClaimDto,
  LearningProposalDto,
} from '@bee-agent/client'
import { App } from '../src/App.tsx'

afterEach(cleanup)

function claim(overrides: Partial<MemoryClaimDto> = {}): MemoryClaimDto {
  return {
    id: 'c1b2c3d4-1111-4222-8333-444455556666',
    kind: 'preference',
    statement: 'Prefer concise answers',
    status: 'active',
    ...overrides,
  }
}

function proposal(
  overrides: Partial<LearningProposalDto> = {},
): LearningProposalDto {
  return {
    id: 'd1c2b3a4-1111-4222-8333-444455556666',
    type: 'skill',
    targetKey: 'skill:lookup',
    hypothesis: 'h',
    status: 'review',
    autonomyLevel: 2,
    origin: 'loop',
    version: 3,
    ...overrides,
  }
}

/**
 * Governance views (v1 refactor plan §5.7 WF6-B): memory shows what Bee
 * remembers with one-click forgetting; learning runs the lifecycle over
 * the same routes the CLI uses.
 */
describe('governance views', () => {
  it('memory lists claims and forgets on click', async () => {
    const list = vi.fn().mockResolvedValue([claim()])
    const forget = vi.fn().mockResolvedValue(claim({ status: 'retracted' }))
    const client = {
      listThreads: vi.fn().mockResolvedValue([]),
      listMemoryObservations: vi.fn().mockResolvedValue([]),
      listMemoryClaims: list,
      forgetMemoryClaim: forget,
      consolidateMemory: vi.fn(),
    } as unknown as BeeAgentClient
    render(<App client={client} />)

    fireEvent.click(screen.getByRole('button', { name: '记忆' }))
    await waitFor(() => {
      expect(screen.getByText(/Prefer concise answers/)).toBeDefined()
    })
    expect(list).toHaveBeenCalledWith({})

    fireEvent.click(screen.getByRole('button', { name: /遗忘/ }))
    await waitFor(() => {
      expect(forget).toHaveBeenCalledWith(
        claim().id,
        'forgotten from the web console',
      )
    })
  })

  it('learning runs the experiment and drives promotion', async () => {
    const reviewProposal = proposal({ status: 'draft', version: 1 })
    const promotedProposal = proposal({ status: 'promoted', version: 4 })
    const list = vi
      .fn()
      .mockResolvedValueOnce([reviewProposal])
      .mockResolvedValueOnce([proposal({ status: 'review', version: 2 })])
      .mockResolvedValueOnce([proposal({ status: 'trial', version: 3 })])
      .mockResolvedValue([promotedProposal])
    const experiment = vi.fn().mockResolvedValue({
      verdict: 'accept',
      metrics: { verifiedUsage: 3 },
    })
    const transition = vi.fn().mockResolvedValue(promotedProposal)
    const client = {
      listThreads: vi.fn().mockResolvedValue([]),
      listLearningProposals: list,
      runLearningExperiment: experiment,
      transitionLearningProposal: transition,
      runLearningLoop: vi.fn(),
      monitorLearningDrift: vi.fn().mockResolvedValue({
        report: { checked: [] },
      }),
    } as unknown as BeeAgentClient
    render(<App client={client} />)

    fireEvent.click(screen.getByRole('button', { name: '学习' }))
    await waitFor(() => {
      expect(screen.getByText(/skill:lookup/)).toBeDefined()
    })

    fireEvent.click(screen.getByRole('button', { name: '隔离实验' }))
    await waitFor(() => {
      expect(experiment).toHaveBeenCalledWith(reviewProposal.id)
      expect(screen.getByText(/实验结论：通过/)).toBeDefined()
    })

    // The experiment's evidence gate already moved it to review; continue
    // trial → promote → rollback through the visible buttons.
    fireEvent.click(screen.getByRole('button', { name: '试用' }))
    await waitFor(() =>
      expect(transition).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'trial', expectedVersion: 2 }),
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: '批准生效' }))
    await waitFor(() =>
      expect(transition).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'promoted', expectedVersion: 3 }),
      ),
    )
    // The promoted proposal offers the one-click rollback.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '回滚' })).toBeDefined()
    })
    fireEvent.click(screen.getByRole('button', { name: '回滚' }))
    await waitFor(() =>
      expect(transition).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'rolled-back', expectedVersion: 4 }),
      ),
    )
  })
  it('diagnostics tab renders the health overview cards', async () => {
    const client = {
      listThreads: vi.fn().mockResolvedValue([]),
      listGrants: vi.fn().mockResolvedValue([]),
      diagnostics: vi.fn().mockResolvedValue({
        status: 'ok',
        structure: {
          activeVersion: 'sha256:abcdef1234567890',
          restartRequired: false,
          restartRequiredPlugins: [],
          doctor: {},
          configSource: {},
        },
        memory: {
          enabled: true,
          health: { status: 'healthy' },
          claims: { total: 9, active: 7, retracted: 2 },
        },
        world: { enabled: true, version: 37, entities: 12, relations: 20 },
        scheduler: { enabled: true, triggers: 3 },
        learning: {
          enabled: true,
          byStatus: { trial: 1, promoted: 2 },
          loopBudget: {},
          driftBudget: {},
        },
        threads: { streams: 40 },
      }),
    } as unknown as BeeAgentClient
    render(<App client={client} />)

    fireEvent.click(screen.getByRole('button', { name: '诊断' }))
    await waitFor(() => {
      expect(screen.getByText('运行正常')).toBeDefined()
    })
    expect(screen.getByText(/声明 9 · 生效 7/)).toBeDefined()
    expect(screen.getByText(/实体 12 · 关系 20/)).toBeDefined()
    expect(screen.getByText(/触发器 3 个/)).toBeDefined()
    expect(screen.getByText('试用中')).toBeDefined()
    expect(screen.getByText(/40 条事件流/)).toBeDefined()
  })
})
