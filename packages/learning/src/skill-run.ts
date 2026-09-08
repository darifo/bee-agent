import { z } from 'zod'
import type { ChronicleStore } from '@bee-agent/knowledge'
interface LlmToolCall {
  callId: string
  toolId: string
  input: unknown
}

interface ToolAuthorizationRule {
  toolId: string
  decision: 'allow' | 'ask' | 'deny'
  reason: string
}

interface LlmToolSpec {
  id: string
  description: string
  inputSchema: Record<string, unknown>
}

interface ToolAdapter {
  spec: LlmToolSpec
  authorization: ToolAuthorizationRule
  describe(call: LlmToolCall): {
    capability: string
    requirements: Record<string, unknown>
    expectedEffects: string[]
    verification: string[]
  }
  execute(call: { call: LlmToolCall }): Promise<{
    output: unknown
    content: string
    isError?: boolean
    verification: string[]
  }>
  concurrency?(call: LlmToolCall): 'parallel' | 'exclusive'
}

/**
 * `skill_run` (architecture §12): the execution surface for promoted
 * skills. The model picks a registered skill by id with an optional
 * input; the host executor rewrites the call into the bound tool's
 * invocation carrying the skill's instructions, so actual effects still
 * route through ExecutionWorld under the bound tool's own capability and
 * approval flow. Nothing here executes in-process.
 */

export const SKILL_RUN_TOOL_ID = 'skill_run'

const SkillRunInputSchema = z.object({
  skillId: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional(),
})
export type SkillRunInput = z.infer<typeof SkillRunInputSchema>

/** The skills stream id; a stable wire contract owned by execution. */
const SKILLS_STREAM_ID = 'skills'

export interface SkillRunAdapterOptions {
  /** The skills stream source; read live on every describe/execute. */
  readonly store: ChronicleStore
}

export interface LiveSkill {
  readonly skillId: string
  readonly name: string
  readonly summary: string
  readonly instructions: string
  readonly boundToolId: string
  readonly typicalInput: Record<string, unknown>
}

/** Reads the live skills map from the durable stream. */
export async function readSkills(
  store: ChronicleStore,
): Promise<Map<string, LiveSkill>> {
  const skills = new Map<string, LiveSkill>()
  for await (const event of store.readStream(SKILLS_STREAM_ID)) {
    const payload = event.payload as {
      skillId?: unknown
      name?: unknown
      summary?: unknown
      instructions?: unknown
      boundToolId?: unknown
      typicalInput?: unknown
    }
    if (typeof payload.skillId !== 'string') continue
    if (event.eventType === 'skill.registered') {
      if (
        typeof payload.name === 'string' &&
        typeof payload.summary === 'string' &&
        typeof payload.instructions === 'string' &&
        typeof payload.boundToolId === 'string' &&
        payload.typicalInput !== undefined &&
        typeof payload.typicalInput === 'object'
      ) {
        skills.set(payload.skillId, {
          skillId: payload.skillId,
          name: payload.name,
          summary: payload.summary,
          instructions: payload.instructions,
          boundToolId: payload.boundToolId,
          typicalInput: payload.typicalInput as Record<string, unknown>,
        })
      }
    } else if (event.eventType === 'skill.revoked') {
      skills.delete(payload.skillId)
    }
  }
  return skills
}

export function createSkillRunAdapter(
  options: SkillRunAdapterOptions,
): ToolAdapter {
  const authorization: ToolAuthorizationRule = {
    toolId: SKILL_RUN_TOOL_ID,
    decision: 'ask',
    reason: '运行已注册技能会调用其绑定的工具，按绑定工具的授权流程执行',
  }
  return {
    spec: {
      id: SKILL_RUN_TOOL_ID,
      description:
        'Run a registered skill by id. Skills are learned, pre-approved invocation patterns for a bound tool; the skill supplies proven instructions and typical input, and you may adjust the input to the task at hand.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['skillId'],
        properties: {
          skillId: {
            type: 'string',
            description: 'Registered skill id.',
          },
          input: {
            type: 'object',
            description:
              'Input for the bound tool; defaults to the skill’s typical input.',
          },
        },
      },
    },
    authorization,
    describe(call: LlmToolCall) {
      if (call.toolId !== SKILL_RUN_TOOL_ID) {
        throw new Error(`skill adapter cannot describe '${call.toolId}'`)
      }
      const input = SkillRunInputSchema.parse(call.input)
      return {
        capability: `tool:${SKILL_RUN_TOOL_ID}`,
        requirements: {
          readPaths: [],
          writePaths: [],
          networkTargets: [],
          commands: [],
          secretEnv: {},
        },
        expectedEffects: [
          `运行技能 '${input.skillId}'（具体效果由绑定的工具与其输入决定）`,
        ],
        verification: ['技能调用结果按绑定工具的验证方式返回'],
      }
    },
    async execute(call: { call: LlmToolCall }): Promise<{
      output: unknown
      content: string
      isError?: boolean
      verification: string[]
    }> {
      const parsed = SkillRunInputSchema.parse(call.call.input)
      const skills = await readSkills(options.store)
      const skill = skills.get(parsed.skillId)
      if (skill === undefined) {
        const available = [...skills.keys()].join(', ') || '(none)'
        return {
          output: {},
          content: `Skill '${parsed.skillId}' 不存在或已被撤销。可用技能：${available}`,
          isError: true,
          verification: [],
        }
      }
      // The host tool executor rewrites this marker into the bound tool's
      // invocation; this in-process body only reports the resolution.
      return {
        output: {
          skillRun: true,
          skillId: skill.skillId,
          boundToolId: skill.boundToolId,
          instructions: skill.instructions,
          input: parsed.input ?? skill.typicalInput,
        },
        content: `技能 '${skill.skillId}'（${skill.name}）已解析：由绑定工具 ${skill.boundToolId} 执行。\n\n技能指令：\n${skill.instructions}`,
        verification: [
          `Resolved skill '${skill.skillId}' to ${skill.boundToolId}`,
        ],
      }
    },
    concurrency() {
      return 'exclusive' as const
    },
  }
}

/**
 * Host convenience: always-on adapter list. The skill catalog stays
 * accurate at describe/execute time because it reads the stream live —
 * an empty catalog simply reports no skills.
 */
export function createSkillRunAdapters(
  options: SkillRunAdapterOptions,
): readonly ToolAdapter[] {
  return [createSkillRunAdapter(options)]
}
