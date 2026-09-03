import type {
  MemoryClaim,
  MemoryDerivationMessage,
  MemoryDerivationResult,
  NewMemoryClaimInput,
  NewMemoryObservationInput,
} from '@bee-agent/knowledge'

/**
 * The deterministic baseline deriver (v1 refactor plan §5.5 WF4-B): scans a
 * completed turn's messages for explicit, durable statements — preferences
 * and corrections — and turns them into claim candidates. The patterns are
 * deliberately conservative (only overt markers match) and injectable: a
 * model-driven deriver can replace this module without touching the provider
 * or the hook plumbing.
 */

const MAX_STATEMENT_LENGTH = 280

/** Overt preference markers inside a sentence (English + common Chinese). */
const PREFERENCE_MARKERS =
  /\b(always|never|prefer|from now on|keep using|remember that|i like|i hate|please (?:always|never))\b|总是|永远|以后请|一直|记住|喜欢|讨厌/u

/** Leading correction markers: the sentence revises an earlier statement. */
const CORRECTION_MARKERS =
  /^(actually|correction:|i meant|on second thought|scratch that|不对|更正|我说错了)/iu

/**
 * Softer attention markers: worth noticing, not confident enough to become
 * a claim. These sentences land as observations — the raw feed the slow
 * loop and the user can review — instead of silently evaporating.
 */
const OBSERVATION_MARKERS =
  /\b(i noticed|i need|i'm using|we use|switched to|started (?:using|working)|today i|recently)\b|我注意到|我需要|我在用|换成了|开始用|最近在/u

function sentences(content: string): string[] {
  return content
    .split(/[.!?。！？\n]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
}

function capStatement(sentence: string): string {
  return sentence.length > MAX_STATEMENT_LENGTH
    ? `${sentence.slice(0, MAX_STATEMENT_LENGTH - 1)}…`
    : sentence
}

function normalizeStatement(statement: string): string {
  return statement
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?。！？]+$/u, '')
}

export interface DeriveClaimOptions {
  /** Active claims, used to resolve correction supersede targets. */
  readonly activeClaims: readonly MemoryClaim[]
}

/**
 * Derives claim candidates from the given messages. Corrections supersede
 * the most recently recorded active preference; both kinds dedupe against
 * each other within the turn. Pure function of its inputs.
 */
export function deriveClaimCandidates(
  messages: readonly MemoryDerivationMessage[],
  options: DeriveClaimOptions,
): MemoryDerivationResult {
  const candidates: NewMemoryClaimInput[] = []
  const observations: NewMemoryObservationInput[] = []
  const seen = new Set<string>()
  const latestPreference = options.activeClaims
    .filter((claim) => claim.status === 'active' && claim.kind === 'preference')
    .sort(
      (a, b) =>
        b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id),
    )
    .at(0)

  for (const message of messages) {
    if (message.role === 'tool') continue
    for (const sentence of sentences(message.content)) {
      const isCorrection = CORRECTION_MARKERS.test(sentence)
      const isPreference = PREFERENCE_MARKERS.test(sentence)

      if (!isCorrection && !isPreference) {
        // Not claim-worthy, but softly attention-marked: record it as an
        // observation so it stays reviewable instead of evaporating.
        if (OBSERVATION_MARKERS.test(sentence)) {
          observations.push({
            content: capStatement(sentence),
            provenance: message.provenance,
            confidence: 0.3,
          })
        }
        continue
      }

      const statement = capStatement(sentence)
      const normalized = normalizeStatement(statement)
      if (seen.has(normalized)) continue
      seen.add(normalized)

      // Every correction in one turn supersedes the most recently recorded
      // active preference; none of the candidates are ingested yet, so the
      // recorded target stays the same. Superseding an already-superseded
      // claim is a harmless no-op at ingest.
      const target = isCorrection ? latestPreference : undefined
      candidates.push({
        kind: isCorrection ? 'correction' : 'preference',
        statement,
        subject: { type: 'user' },
        provenance: message.provenance,
        confidence: isCorrection ? 0.7 : 0.6,
        ...(target !== undefined ? { supersedes: [target.id] } : {}),
      })
    }
  }
  return { claims: candidates, observations }
}

export { normalizeStatement }
