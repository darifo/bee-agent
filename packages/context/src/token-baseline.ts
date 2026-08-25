import { estimateTokens } from './context-manifest.ts'
import { compileContextManifest } from './context-budget.ts'
import type { PromptSection } from './context-budget.ts'
import { SkillRegistry } from './skill-registry.ts'
import { estimateSkillTokens, estimateSummaryTokens } from './skill.ts'
import type { Skill } from './skill.ts'
import { ToolRegistry } from './tool-registry.ts'
import { estimateToolTokens, measureToolContextCost } from './tool.ts'
import type { ToolDefinition } from './tool.ts'

/**
 * Token baseline benchmark (v1 refactor plan §5.2 P2-10): compares the naive
 * full context (all history + all tool specs + all skills) against the
 * budgeted + two-stage context (budgeted history, resident tools + long-tail
 * summaries, skill summaries). Everything is deterministic (characters-over-
 * four tokens), so the savings ratio is a stable CI gate.
 */

export interface TokenBaselineScenario {
  readonly name: string
  readonly history: readonly { role: string; content: string }[]
  readonly tools: readonly ToolDefinition[]
  readonly skills: readonly Skill[]
  readonly budgetTokens: number
}

export interface TokenBaselineBreakdown {
  readonly history: { full: number; optimized: number }
  readonly tools: { full: number; optimized: number }
  readonly skills: { full: number; optimized: number }
}

export interface TokenBaselineReport {
  readonly name: string
  readonly baselineTokens: number
  readonly optimizedTokens: number
  /** optimized / baseline; lower is better. */
  readonly savingsRatio: number
  readonly breakdown: TokenBaselineBreakdown
}

const MANIFEST_ID = '00000000-0000-4000-8000-000000000000'

export function measureTokenBaseline(
  scenario: TokenBaselineScenario,
): TokenBaselineReport {
  // Naive baseline: full history + full tool specs + full skills.
  const historyFull = scenario.history.reduce(
    (sum, message) => sum + estimateTokens(message.content),
    0,
  )
  const toolFull = scenario.tools.reduce(
    (sum, tool) => sum + estimateToolTokens(tool),
    0,
  )
  const skillFull = scenario.skills.reduce(
    (sum, skill) => sum + estimateSkillTokens(skill),
    0,
  )

  // Optimized history: the full pipeline compresses and budget-allocates it.
  const historySections: PromptSection[] = scenario.history.map(
    (message, index) => ({
      id: `history-${index}`,
      kind: 'trajectory',
      priority: 8,
      content: message.content,
    }),
  )
  const manifest = compileContextManifest({
    id: MANIFEST_ID,
    promptVersion: 'v1',
    structureVersion: 'structure-v1',
    tokenBudget: scenario.budgetTokens,
    sections: historySections,
  })
  const historyOptimized = manifest.sections.reduce(
    (sum, section) => sum + section.tokens,
    0,
  )

  // Optimized tools: resident full specs + long-tail summaries.
  const toolRegistry = new ToolRegistry()
  for (const tool of scenario.tools) toolRegistry.register(tool)
  const toolOptimized = measureToolContextCost(
    toolRegistry.residentSpecs(),
    toolRegistry.index(),
  ).indexedTokens

  // Optimized skills: summaries only (the index stage).
  const skillRegistry = new SkillRegistry()
  for (const skill of scenario.skills) skillRegistry.register(skill)
  const skillOptimized = skillRegistry
    .index()
    .reduce((sum, summary) => sum + estimateSummaryTokens(summary), 0)

  const baselineTokens = historyFull + toolFull + skillFull
  const optimizedTokens = historyOptimized + toolOptimized + skillOptimized

  return {
    name: scenario.name,
    baselineTokens,
    optimizedTokens,
    savingsRatio: optimizedTokens / baselineTokens,
    breakdown: {
      history: { full: historyFull, optimized: historyOptimized },
      tools: { full: toolFull, optimized: toolOptimized },
      skills: { full: skillFull, optimized: skillOptimized },
    },
  }
}

/** A bulky tool input schema, to make the full spec cost dominate. */
function bigSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(
      Array.from({ length: 18 }, (_, i) => [
        `param_${i}`,
        { type: 'string', description: `Parameter ${i} description text` },
      ]),
    ),
  }
}

function skillFixture(id: string, name: string): Skill {
  return {
    id,
    name,
    version: '1.0.0',
    summary: `${name} — a short procedural summary`,
    description: `${name} detailed instructions that run for many lines: first do this, then do that, then verify the result, and finally report back with the outcome and any caveats you found along the way.`,
    tags: [name.toLowerCase()],
    riskLevel: 'low',
    requiredCapabilities: ['llm'],
    requiredPermissions: [],
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'string' },
    evalCases: [],
    knownFailureModes: ['Fails when the input is empty'],
  }
}

function historyFixture(count: number): { role: string; content: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Message number ${i}: a reasonably long turn of the conversation that carries several sentences worth of context about the ongoing task.`,
  }))
}

/** The fixed golden scenario set: two representative workloads. */
export const GOLDEN_SCENARIOS: readonly TokenBaselineScenario[] = [
  {
    name: 'research',
    history: historyFixture(12),
    tools: [
      {
        id: 'core.calculator',
        description: 'Evaluate arithmetic',
        resident: true,
        inputSchema: { type: 'object', properties: {} },
      },
      {
        id: 'mcp.github',
        description: 'Browse GitHub',
        inputSchema: bigSchema(),
      },
      { id: 'mcp.files', description: 'Read files', inputSchema: bigSchema() },
      {
        id: 'mcp.browser',
        description: 'Drive a browser',
        inputSchema: bigSchema(),
      },
      {
        id: 'mcp.database',
        description: 'Query a database',
        inputSchema: bigSchema(),
      },
      { id: 'mcp.mail', description: 'Send email', inputSchema: bigSchema() },
    ],
    skills: [
      skillFixture('bee.skills.summarize', 'Summarize'),
      skillFixture('bee.skills.extract', 'Extract'),
    ],
    budgetTokens: 120,
  },
  {
    name: 'coding',
    history: historyFixture(10),
    tools: [
      {
        id: 'core.fs',
        description: 'Read and write files',
        resident: true,
        inputSchema: { type: 'object', properties: {} },
      },
      {
        id: 'mcp.git',
        description: 'Run git commands',
        inputSchema: bigSchema(),
      },
      {
        id: 'mcp.test',
        description: 'Run the test suite',
        inputSchema: bigSchema(),
      },
      {
        id: 'mcp.lint',
        description: 'Lint the codebase',
        inputSchema: bigSchema(),
      },
      {
        id: 'mcp.build',
        description: 'Build the project',
        inputSchema: bigSchema(),
      },
    ],
    skills: [
      skillFixture('bee.skills.refactor', 'Refactor'),
      skillFixture('bee.skills.review', 'Code review'),
      skillFixture('bee.skills.debug', 'Debug'),
    ],
    budgetTokens: 100,
  },
]

/** Runs the golden scenario set and returns one report per scenario. */
export function runTokenBaseline(): readonly TokenBaselineReport[] {
  return GOLDEN_SCENARIOS.map(measureTokenBaseline)
}
