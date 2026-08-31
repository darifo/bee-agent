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
      listMemoryClaims: list,
      forgetMemoryClaim: forget,
      consolidateMemory: vi.fn(),
    } as unknown as BeeAgentClient
    render(<App client={client} />)

    fireEvent.click(screen.getByRole('button', { name: 'Memory' }))
    await waitFor(() => {
      expect(screen.getByText(/Prefer concise answers/)).toBeDefined()
    })
    expect(list).toHaveBeenCalledWith({})

    fireEvent.click(screen.getByRole('button', { name: /forget/i }))
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
      listLearningProposals: list,
      runLearningExperiment: experiment,
      transitionLearningProposal: transition,
      runLearningLoop: vi.fn(),
      monitorLearningDrift: vi.fn().mockResolvedValue({
        report: { checked: [] },
      }),
    } as unknown as BeeAgentClient
    render(<App client={client} />)

    fireEvent.click(screen.getByRole('button', { name: 'Learning' }))
    await waitFor(() => {
      expect(screen.getByText(/skill:lookup/)).toBeDefined()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Experiment' }))
    await waitFor(() => {
      expect(experiment).toHaveBeenCalledWith(reviewProposal.id)
      expect(screen.getByText(/experiment: accept/)).toBeDefined()
    })

    // The experiment's evidence gate already moved it to review; continue
    // trial → promote → rollback through the visible buttons.
    fireEvent.click(screen.getByRole('button', { name: 'Trial' }))
    await waitFor(() =>
      expect(transition).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'trial', expectedVersion: 2 }),
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Promote' }))
    await waitFor(() =>
      expect(transition).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'promoted', expectedVersion: 3 }),
      ),
    )
    // The promoted proposal offers the one-click rollback.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Roll back' })).toBeDefined()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Roll back' }))
    await waitFor(() =>
      expect(transition).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'rolled-back', expectedVersion: 4 }),
      ),
    )
  })
})
