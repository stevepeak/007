// The decision domain: judging one shared state against several typed questions
// and getting back calibrated probabilities instead of prose.
//
// This is a SECOND kind of provider, parallel to the chat models in
// `model-catalog.ts` and deliberately not folded into them. A chat model takes
// messages and answers with text; a decider takes a state plus questions and
// answers with distributions. Nothing about the two contracts is substitutable,
// so `ModelOption`/`getModel` stay exactly as they were and this sits beside
// them — same shape of seam (catalog + provider + factory), different contract.
//
// ── The load-bearing split: providers report, the ENGINE decides ─────────────
// A {@link Decider} returns probabilities and nothing else. It never says
// whether the answer was "yes", never picks the winning option, never decides
// whether an answer was confident enough to act on. All of that is policy, it
// lives on the node where the author can see it, and it is computed here by
// {@link resolveVerdict} so every provider's answers mean the same thing.
//
// That split is what makes the seam portable rather than nominally generic:
//   • A provider that only reports a distribution is a complete provider.
//   • Two providers' `confidence` values are comparable, so an escalation
//     threshold authored against one still means something against the other.
//   • Swapping providers cannot silently move a threshold, because no provider
//     ever saw it.
//
// Nothing in this file names a vendor. The Venice/Jev vocabulary (`noul`,
// `criteria`, `legend`) exists only in the host adapter that translates to it.

/** The three shapes of judgment a decider can be asked for. */
export const DECISION_QUESTION_TYPES = [
  'boolean',
  'category',
  'scale',
] as const
export type DecisionQuestionType = (typeof DECISION_QUESTION_TYPES)[number]

/** One named option (a category) or one named level (a point on a scale). */
export type DecisionOption = {
  /** Stable machine key — what a verdict reports and an edge routes on. */
  key: string
  /** What this option/level means, so a provider can tell them apart. */
  description?: string
}

/** Yes/no. Answered with a probability, never a boolean — see the note above. */
export type BooleanQuestion = {
  id: string
  type: 'boolean'
  prompt: string
  /** Optional named things to weigh, e.g. `{ overdue: 'No reply in 48h' }`. */
  considerations?: Readonly<Record<string, string>>
}

/** Pick one of several unordered options. */
export type CategoryQuestion = {
  id: string
  type: 'category'
  prompt: string
  options: readonly DecisionOption[]
}

/**
 * Position on an ORDERED spectrum, lowest level first. The verdict carries both
 * the probability-weighted index (so "just past annoyed" is distinguishable
 * from "solidly furious") and the nearest level's key.
 */
export type ScaleQuestion = {
  id: string
  type: 'scale'
  prompt: string
  levels: readonly DecisionOption[]
}

export type DecisionQuestion =
  | BooleanQuestion
  | CategoryQuestion
  | ScaleQuestion

/** The choices a question offers, or `[]` for a boolean. One accessor so
 * callers don't branch on `type` to reach `options` vs `levels`. */
export function questionChoices(
  question: DecisionQuestion,
): readonly DecisionOption[] {
  if (question.type === 'category') return question.options
  if (question.type === 'scale') return question.levels
  return []
}

// ── What a provider returns ──────────────────────────────────────────────────

/** One key's share of the probability mass. */
export type DecisionDistributionEntry = { key: string; probability: number }

/**
 * A provider's RAW answer: probabilities, and at most a confidence of its own.
 * Deliberately carries no verdict — see the header.
 *
 * `confidence` is optional and means "the provider has its own calibrated
 * measure of how sure it is". Most don't; {@link resolveVerdict} derives one
 * that is comparable across providers when it is absent.
 */
export type DecisionAnswer =
  | {
      id: string
      type: 'boolean'
      /** Probability the answer is yes, 0–1. */
      probability: number
      confidence?: number
    }
  | {
      id: string
      type: 'category'
      /** One entry per option the question declared. */
      distribution: readonly DecisionDistributionEntry[]
      confidence?: number
    }
  | {
      id: string
      type: 'scale'
      /** One entry per level the question declared, in the question's order. */
      distribution: readonly DecisionDistributionEntry[]
      confidence?: number
    }

/** Tokens a decision cost, when the provider reports them. */
export type DecisionUsage = { inputTokens?: number; outputTokens?: number }

export type DecisionRequest = {
  /** The shared context every question is judged against. Any JSON value. */
  state: unknown
  /** Judged together, against the same state. */
  questions: readonly DecisionQuestion[]
}

export type DecisionResponse = {
  /** What actually answered, for the run record. Floating ids drift. */
  modelId?: string
  answers: readonly DecisionAnswer[]
  usage?: DecisionUsage
}

/**
 * The node-facing provider call, with the run context already bound in — the
 * exact shape of {@link ModelFactory}, one layer down.
 *
 * A decider MUST answer every question it was asked, with an answer whose
 * `type` matches the question's.
 *
 * `maxQuestionsPerCall` rides on the function rather than being looked up in the
 * catalog at dispatch time: the engine would otherwise have to thread an async,
 * env-reading `listDecisionModels` call into every node run to learn one number
 * the host already knew when it built the decider. A host sets this and
 * {@link DecisionModelOption.maxQuestionsPerCall} from the same constant — the
 * catalog value is what the EDITOR warns against, this is what the engine chunks
 * on.
 */
export type Decider = ((
  request: DecisionRequest,
) => Promise<DecisionResponse>) & {
  maxQuestionsPerCall?: number
}

// ── Catalog: how a host describes its deciders to the editor ─────────────────

/**
 * How a decision model is implemented. `native` is a purpose-built decision
 * endpoint; `chat-emulated` is a chat model constrained to structured output
 * (see `createChatDecider`), which is slower and less calibrated but available
 * to every host; `custom` is anything else — a classifier, a rules engine, a
 * human queue.
 */
export type DecisionProviderKind = 'native' | 'chat-emulated' | 'custom'

export type DecisionProvider = {
  id: string
  /** Display name, e.g. "Venice AI". */
  label: string
  kind: DecisionProviderKind
  /** Optional one-line note shown under the provider header. */
  note?: string
}

/**
 * A decider the editor can offer and `getDecider` can resolve. Mirrors
 * {@link ModelOption}, with the capability fields a decision node actually
 * gates on.
 */
export type DecisionModelOption = {
  id: string
  label: string
  providerId?: string
  /**
   * Question types this model can answer. Omitted → assumed to answer all
   * three; a model is only ever gated out of a node for a type it is KNOWN to
   * lack, the same rule `unmetRequirements` uses for chat capabilities.
   */
  questionTypes?: readonly DecisionQuestionType[]
  /**
   * True when the probabilities are genuinely calibrated rather than a model's
   * self-report. Surfaced as a badge: a confidence threshold authored against a
   * calibrated model means less against an uncalibrated one, and an author
   * choosing between them deserves to know which they have.
   */
  calibrated?: boolean
  /**
   * Most questions the provider accepts in one request. The engine chunks past
   * it rather than failing, so a host that hasn't measured one can omit it.
   */
  maxQuestionsPerCall?: number
  /** Blended cost per 1M tokens, USD, when the provider reports it. */
  costPerMTok?: number
  /** Max state size in tokens, when the provider declares one. */
  contextLength?: number
}

/** True when `model` is known to be unable to answer `type`. */
export function supportsQuestionType(
  model: DecisionModelOption,
  type: DecisionQuestionType,
): boolean {
  return model.questionTypes == null || model.questionTypes.includes(type)
}

/** Question types in `questions` that `model` is known to lack, for gating. */
export function unsupportedQuestionTypes(
  model: DecisionModelOption,
  questions: readonly DecisionQuestion[],
): DecisionQuestionType[] {
  const needed = new Set(questions.map((q) => q.type))
  return [...needed].filter((t) => !supportsQuestionType(model, t))
}

// ── Verdicts: the engine's interpretation ────────────────────────────────────

/** The default cut for a boolean question when a node declares none. */
export const DEFAULT_DECISION_THRESHOLD = 0.5

export type DecisionVerdict =
  | {
      id: string
      type: 'boolean'
      /** `probability >= threshold`. The arm a boolean question routes to. */
      value: boolean
      probability: number
      /** The cut applied, recorded so a run trace explains its own routing. */
      threshold: number
      confidence: number
      distribution: readonly DecisionDistributionEntry[]
    }
  | {
      id: string
      type: 'category'
      /** The winning option key. */
      value: string
      confidence: number
      distribution: readonly DecisionDistributionEntry[]
    }
  | {
      id: string
      type: 'scale'
      /** Probability-weighted index, e.g. 1.84 across three levels. */
      value: number
      /** The level `value` lands nearest — what a scale question routes on. */
      level: string
      confidence: number
      distribution: readonly DecisionDistributionEntry[]
    }

/**
 * How sure an answer is, 0–1, on one scale for every question type and every
 * provider: the MARGIN between the top two probabilities.
 *
 * Margin rather than top-probability because the question a caller is really
 * asking is "was this close?", and a 0.51/0.49 split should read as maximally
 * unsure even though its top probability is a healthy-looking 0.51.
 *
 * It also makes the binary case fall out of the same formula rather than being
 * special-cased: for `{yes: p, no: 1-p}` the margin is `|p - (1-p)|`, which is
 * exactly `|p - 0.5| * 2`. One definition, so a threshold authored against a
 * boolean question means the same thing on a category one.
 *
 * A single-key distribution has no runner-up and scores 1.
 */
export function distributionConfidence(
  distribution: readonly DecisionDistributionEntry[],
): number {
  if (distribution.length === 0) return 0
  const sorted = [...distribution].sort((a, b) => b.probability - a.probability)
  const top = sorted[0].probability
  const next = sorted[1]?.probability ?? 0
  return clamp01(top - next)
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/** A boolean answer as a two-key distribution, so one formula covers all three
 * types and a trace can show a boolean's split like any other. */
function booleanDistribution(
  probability: number,
): DecisionDistributionEntry[] {
  const yes = clamp01(probability)
  return [
    { key: 'yes', probability: yes },
    { key: 'no', probability: 1 - yes },
  ]
}

export type ResolveVerdictOptions = {
  /** Cut for a boolean question. Defaults to {@link DEFAULT_DECISION_THRESHOLD}. */
  threshold?: number
}

/**
 * Turn one provider answer into the engine's verdict — the single place a
 * probability becomes a decision.
 *
 * `question` is passed alongside the answer because the ORDER of a scale's
 * levels is the question's, not the answer's: a provider may return its
 * distribution in any order, and a weighted index computed against the wrong
 * order is a plausible-looking number that is simply wrong. Levels are indexed
 * by their position in the question.
 */
export function resolveVerdict(
  question: DecisionQuestion,
  answer: DecisionAnswer,
  options: ResolveVerdictOptions = {},
): DecisionVerdict {
  if (answer.type !== question.type) {
    throw new Error(
      `Decision question '${question.id}' was asked as '${question.type}' but answered as '${answer.type}'.`,
    )
  }

  if (question.type === 'boolean' && answer.type === 'boolean') {
    const threshold = options.threshold ?? DEFAULT_DECISION_THRESHOLD
    const probability = clamp01(answer.probability)
    const distribution = booleanDistribution(probability)
    return {
      id: question.id,
      type: 'boolean',
      value: probability >= threshold,
      probability,
      threshold,
      confidence: answer.confidence ?? distributionConfidence(distribution),
      distribution,
    }
  }

  if (question.type === 'category' && answer.type === 'category') {
    const distribution = alignToChoices(question.options, answer.distribution)
    const top = distribution.reduce((best, entry) =>
      entry.probability > best.probability ? entry : best,
    )
    return {
      id: question.id,
      type: 'category',
      value: top.key,
      confidence: answer.confidence ?? distributionConfidence(distribution),
      distribution,
    }
  }

  // Scale. The weighted index is the point of this type: a caller that only
  // wanted the nearest level could have asked a category question.
  //
  // The pair is re-narrowed rather than cast: the `type` equality checked at the
  // top of this function is a runtime fact TypeScript cannot carry across two
  // separate unions, and a cast on the ANSWER (rather than the question) would
  // be the one that could silently read `distribution` off a boolean.
  if (question.type !== 'scale' || answer.type !== 'scale') {
    throw new Error(
      `Decision question '${question.id}': unhandled type '${question.type}'.`,
    )
  }
  const levels = question.levels
  const distribution = alignToChoices(levels, answer.distribution)
  const total = distribution.reduce((sum, e) => sum + e.probability, 0)
  const weighted =
    total > 0
      ? distribution.reduce((sum, e, i) => sum + i * e.probability, 0) / total
      : 0
  const nearest = levels[Math.min(levels.length - 1, Math.round(weighted))]
  return {
    id: question.id,
    type: 'scale',
    value: weighted,
    level: nearest?.key ?? '',
    confidence: answer.confidence ?? distributionConfidence(distribution),
    distribution,
  }
}

/**
 * Re-key a provider's distribution onto the question's own choices, in the
 * question's order, filling anything it left out with 0.
 *
 * Both halves matter. The order fixes the scale index (above). The fill closes
 * the gap where a provider reports only the options it considered plausible:
 * without it a two-entry answer to a five-option question would produce a
 * distribution whose indices no longer line up with the levels, and a
 * confidence margin measured against a runner-up that isn't there.
 */
function alignToChoices(
  choices: readonly DecisionOption[],
  distribution: readonly DecisionDistributionEntry[],
): DecisionDistributionEntry[] {
  const byKey = new Map(distribution.map((e) => [e.key, e.probability]))
  return choices.map((choice) => ({
    key: choice.key,
    probability: clamp01(byKey.get(choice.key) ?? 0),
  }))
}

/**
 * Every verdict for a decision, keyed by question id.
 *
 * Throws when an answer is missing or mistyped rather than skipping it. A
 * question with no answer would otherwise reach a routing comparison as
 * `undefined` — and `undefined >= 0.5` is `false`, so the node would route
 * confidently down the "no" arm having never been told anything. For a decision
 * node that is the worst available failure, so it is a loud one.
 */
export function resolveVerdicts(
  questions: readonly DecisionQuestion[],
  answers: readonly DecisionAnswer[],
  options: ResolveVerdictOptions = {},
): Record<string, DecisionVerdict> {
  const byId = new Map(answers.map((a) => [a.id, a]))
  const verdicts: Record<string, DecisionVerdict> = {}
  for (const question of questions) {
    const answer = byId.get(question.id)
    if (!answer) {
      throw new Error(
        `The decision provider did not answer question '${question.id}'.`,
      )
    }
    verdicts[question.id] = resolveVerdict(question, answer, options)
  }
  return verdicts
}

/** One-line trace of how a verdict was reached, for the run inspector. */
export function verdictReasoning(verdict: DecisionVerdict): string {
  if (verdict.type === 'boolean') {
    return `${verdict.id}: p=${fmt(verdict.probability)} ${
      verdict.value ? '≥' : '<'
    } ${fmt(verdict.threshold)} → ${verdict.value ? 'yes' : 'no'} (confidence ${fmt(verdict.confidence)})`
  }
  if (verdict.type === 'category') {
    return `${verdict.id}: ${verdict.value} (confidence ${fmt(verdict.confidence)})`
  }
  return `${verdict.id}: ${fmt(verdict.value)} → ${verdict.level} (confidence ${fmt(verdict.confidence)})`
}

function fmt(n: number): string {
  return n.toFixed(2)
}

/**
 * Split a question list into chunks a model will accept, preserving order.
 * `max` unset or non-positive → one chunk, which is the common case.
 */
export function chunkQuestions(
  questions: readonly DecisionQuestion[],
  max: number | undefined,
): DecisionQuestion[][] {
  if (max == null || max <= 0 || questions.length <= max) {
    return [[...questions]]
  }
  const chunks: DecisionQuestion[][] = []
  for (let i = 0; i < questions.length; i += max) {
    chunks.push(questions.slice(i, i + max))
  }
  return chunks
}
