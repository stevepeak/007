import { tool } from 'ai'
import { z } from 'zod'

import {
  resolveVerdicts,
  type Decider,
  type DecisionQuestion,
  type DecisionVerdict,
} from './decision'
import type { ToolRegistryEntry } from './tool-registry'

/**
 * `assess`: the SDK's built-in agent-facing decision tool.
 *
 * The agent hands over a block of state and a list of typed questions; one
 * request answers all of them and returns probabilities rather than prose. This
 * is the thing an agent cannot do for itself: asking the LLM "is this urgent?"
 * costs a whole generation per question and yields a word, not a number it can
 * threshold — and an LLM's own stated confidence is a guess about a guess.
 *
 *   agent emits assess({ state, questions[] })
 *     → validate each question's shape (the model chose it, so it can get it wrong)
 *         └─ malformed → structured `error`, NO provider call, model can retry
 *     → ONE `Decider` call, every question judged against the same state
 *     → normalized answers + a confidence the agent can escalate on
 *
 * The agent-facing half of the decision support. Its sibling is the Decision
 * NODE, which an author places in a graph and which routes edges on a verdict;
 * this one is chosen BY THE MODEL, mid-reasoning, when it decides it needs a
 * number rather than its own hunch. Different callers, different placement, same
 * underlying judgment.
 *
 * It ships here rather than in a host because there is nothing host-specific in
 * it: it speaks only `decision.ts`'s contract, and resolves its answers with the
 * very same `resolveVerdicts` the Decision node uses. That shared resolution is
 * the point — an agent asking "is this urgent?" and a Decision node asking the
 * same thing cannot come back with numbers that mean different things. A host
 * supplies only a {@link Decider}; the tool names no vendor and knows of none.
 *
 * ── Why the input schema is flat ─────────────────────────────────────────────
 * A question is naturally a discriminated union — `choice` needs options,
 * `score` needs levels, `yes_no` needs neither. It is NOT written that way,
 * because zod emits `oneOf` for a discriminated union and the strict
 * structured-output dialect every provider copied does not support `oneOf`: the
 * constraint is dropped silently and the tool presents as flaky model behavior
 * rather than as a bug we own. So: one flat shape, `.nullish()` for the
 * type-specific fields, and the combination checked in code with a message
 * aimed at the model. See `strict-schema.ts` in the SDK.
 */

/** Ceiling on questions per call — a runaway list is a prompt bug, not a need. */
const MAX_QUESTIONS = 20

/**
 * Ceiling on `state`, in characters — a provider-agnostic backstop against the
 * obvious runaway (an agent pasting a whole document into a judgment).
 *
 * Deliberately generous and deliberately in CHARACTERS: the real limit is a
 * provider's token budget, which differs per provider and which nothing here can
 * count. Its job is to turn "an agent pasted a book" into a message the model
 * can act on, while leaving a genuinely large state to fail against the
 * provider's own limit, where the error can be specific about it.
 */
const MAX_STATE_CHARS = 120_000

const questionSchema = z.object({
  id: z
    .string()
    .describe(
      'Your name for this question. The answer comes back under the same id.',
    ),
  type: z
    .enum(['yes_no', 'choice', 'score'])
    .describe(
      'yes_no — a probability the answer is yes. choice — pick one of `options`. score — a position on the ordered `levels` scale.',
    ),
  instructions: z
    .string()
    .describe(
      'The question itself, e.g. "Does this need a lawyer to review it before sending?"',
    ),
  options: z
    .array(
      z.object({
        key: z
          .string()
          .describe('Short machine-friendly name, e.g. "billing".'),
        meaning: z
          .string()
          .describe(
            'What this option covers, so the model can tell them apart.',
          ),
      }),
    )
    .nullish()
    .describe('Required for `choice`; null otherwise. At least two options.'),
  levels: z
    .array(z.string())
    .nullish()
    .describe(
      'Required for `score`; null otherwise. Ordered low → high, e.g. ["routine", "sensitive", "urgent"]. At least two levels.',
    ),
})

const assessInputSchema = z.object({
  state: z
    .string()
    .describe(
      'The context every question is judged against — the message, the clause, the matter summary. Include everything needed to answer; the model sees nothing else.',
    ),
  questions: z
    .array(questionSchema)
    .describe(
      'Ask everything you need in ONE call — they are judged in parallel against the same state and cost one request.',
    ),
})

const answerSchema = z.object({
  id: z.string(),
  type: z.enum(['yes_no', 'choice', 'score']),
  /**
   * How sure the judgment is, 0–1, uniform across the three types and every
   * provider — the signal to act automatically or hand off to a person. Derived
   * by the engine (`distributionConfidence`), so it means one thing no matter
   * who answered; for `yes_no` that works out as distance from the coin flip
   * (0.93 → 0.86).
   */
  confidence: z.number(),
  /** `yes_no`: probability the answer is yes. Null for the other types. */
  probability: z.number().nullish(),
  /** `choice`: the winning option key. Null for the other types. */
  choice: z.string().nullish(),
  /** `choice`: every option's probability, so a near-tie is visible. */
  options: z
    .array(z.object({ key: z.string(), probability: z.number() }))
    .nullish(),
  /** `score`: probability-weighted position, e.g. 1.84 on a 3-level scale. */
  score: z.number().nullish(),
  /** `score`: the level `score` lands nearest, e.g. "urgent". */
  label: z.string().nullish(),
})

const assessOutputSchema = z.object({
  answers: z.array(answerSchema),
  /**
   * Set when nothing was asked — a malformed question, or a provider failure.
   * `answers` is then empty. Phrased for the model, which is the thing that can
   * fix a bad question and call again.
   */
  error: z.string().nullish(),
})

export type AssessArgs = z.infer<typeof assessInputSchema>
export type AssessResult = z.infer<typeof assessOutputSchema>

type Question = AssessArgs['questions'][number]

/**
 * Translate one model-authored question into the SDK's decision contract, or say
 * what is wrong with it.
 *
 * The union the input schema can't express is enforced here instead. Messages
 * name the field and the fix, because the reader is the model and its next move
 * is to call again.
 */
function toDecisionQuestion(q: Question): DecisionQuestion | string {
  if (q.type === 'yes_no') {
    return { id: q.id, type: 'boolean', prompt: q.instructions }
  }
  if (q.type === 'choice') {
    const options = q.options ?? []
    if (options.length < 2) {
      return `question '${q.id}' is type 'choice' and needs at least two \`options\`.`
    }
    if (new Set(options.map((o) => o.key)).size !== options.length) {
      return `question '${q.id}' has duplicate option keys — each \`key\` must be unique.`
    }
    return {
      id: q.id,
      type: 'category',
      prompt: q.instructions,
      options: options.map((o) => ({ key: o.key, description: o.meaning })),
    }
  }
  const levels = q.levels ?? []
  if (levels.length < 2) {
    return `question '${q.id}' is type 'score' and needs at least two \`levels\`, ordered low to high.`
  }
  return {
    id: q.id,
    type: 'scale',
    prompt: q.instructions,
    // The label IS the key here: the model authored these as plain strings, and
    // it is the one that will read the answer back.
    levels: levels.map((label) => ({ key: label })),
  }
}

/** A resolved verdict → the flat shape the agent reads. */
function normalize(
  type: Question['type'],
  verdict: DecisionVerdict,
): z.infer<typeof answerSchema> {
  const base = { id: verdict.id, type, confidence: verdict.confidence }
  if (verdict.type === 'boolean') {
    return { ...base, probability: verdict.probability }
  }
  if (verdict.type === 'category') {
    return {
      ...base,
      choice: verdict.value,
      options: verdict.distribution.map((d) => ({
        key: d.key,
        probability: d.probability,
      })),
    }
  }
  return { ...base, score: verdict.value, label: verdict.level }
}

export async function assess(
  args: AssessArgs,
  decide: Decider,
): Promise<AssessResult> {
  const { state, questions } = args

  if (questions.length === 0) {
    return { answers: [], error: 'Ask at least one question.' }
  }
  if (questions.length > MAX_QUESTIONS) {
    return {
      answers: [],
      error: `Too many questions (${questions.length}); the limit is ${MAX_QUESTIONS} per call.`,
    }
  }
  if (state.length > MAX_STATE_CHARS) {
    return {
      answers: [],
      error: `The \`state\` is too long (${state.length} characters; the limit is ${MAX_STATE_CHARS}). Summarize it, or assess the relevant section.`,
    }
  }

  const byId = new Map<string, Question>()
  const asked: DecisionQuestion[] = []
  for (const question of questions) {
    if (byId.has(question.id)) {
      return {
        answers: [],
        error: `Duplicate question id '${question.id}' — each id must be unique.`,
      }
    }
    const translated = toDecisionQuestion(question)
    if (typeof translated === 'string') {
      return { answers: [], error: translated }
    }
    byId.set(question.id, question)
    asked.push(translated)
  }

  try {
    const response = await decide({ state, questions: asked })
    // `resolveVerdicts` is the SAME resolution the Decision node runs — the
    // threshold, the winner, the weighted scale index and the confidence all
    // come from one place, so the two callers can't drift.
    const verdicts = resolveVerdicts(asked, response.answers)
    return {
      answers: asked.map((q) => normalize(byId.get(q.id)!.type, verdicts[q.id])),
    }
  } catch (err) {
    // A provider failure is reported to the agent rather than thrown: a thrown
    // tool error ends the generation, and "I couldn't get a judgment" is
    // something the agent can reason around (answer conservatively, escalate).
    // The message carries the provider's own field-level complaint where it had
    // one, which is the whole diagnosis when a question was malformed in a way
    // the checks above missed.
    const message = err instanceof Error ? err.message : String(err)
    return { answers: [], error: `Assessment failed: ${message}` }
  }
}

const ASSESS_DESCRIPTION =
  'Get calibrated probabilities instead of your own guess. Give it the relevant context as `state` plus one or more typed questions, and it returns a number per question — a probability for yes/no, a chosen option with every option\'s odds, or a position on an ordered scale — each with a confidence. Use it before acting on a judgment call ("is this urgent?", "which team owns this?", "how sensitive is this clause?"), and hand off to a person when confidence is low. Ask everything in ONE call: the questions are judged together against the same state and cost a single request.'

export type CreateAssessToolOptions<TDeps> = {
  /**
   * Reach the run's {@link Decider} out of the host's per-run deps — the same
   * accessor shape every other SDK tool uses for a host resource
   * (`createExtractTextTool`'s `getBucket`, and so on).
   *
   * It comes from the deps bundle rather than from `WfSdkConfig.getDecider`
   * because a tool's `build` is handed only `TDeps`: the run context that
   * `getDecider` needs never reaches it. A host builds one decider in
   * `buildRunDeps` and points this at it, which is one line and keeps the
   * agent tool and the Decision node on the same provider.
   */
  getDecider: (deps: TDeps) => Decider
  /** Override the registry id. Renaming does not re-author it — see `origin`. */
  id?: string
  name?: string
  description?: string
  icon?: string
  iconName?: string
  color?: string
  statusLabel?: string
}

/**
 * Build the `assess` registry entry.
 *
 * Wire it beside the host's own tools:
 *
 * ```ts
 * const toolRegistry = new Map([
 *   ...hostTools,
 *   createAssessTool<HostDeps>({ getDecider: (d) => d.decide }),
 * ].map((t) => [t.id, t]))
 * ```
 */
export function createAssessTool<TDeps>(
  opts: CreateAssessToolOptions<TDeps>,
): ToolRegistryEntry<TDeps> {
  const description = opts.description ?? ASSESS_DESCRIPTION
  return {
    id: opts.id ?? 'assess',
    // Shipped by the SDK — see `ToolMeta.origin`. Still true when a host renames
    // it: `opts.name` re-labels the tool, it does not re-author it.
    origin: 'sdk',
    name: opts.name ?? 'Assess',
    description,
    icon: opts.icon,
    iconName: opts.iconName ?? 'Scale',
    color: opts.color ?? 'violet',
    // Static: a `statusLabel` interpolates only TOP-LEVEL args, and neither
    // `state` (potentially a whole document) nor `questions` (an array) is
    // something to put in front of an end user.
    statusLabel: opts.statusLabel ?? 'Weighing the options',
    // No external side effect — but it is a paid provider call, so under an
    // eval's `simulate` it takes the run's fixture by default and runs live only
    // when the Sample asks for live reads. That keeps a graded cell
    // deterministic and off the network.
    sideEffect: 'read',
    kind: 'ai-tool',
    inputSchema: assessInputSchema,
    outputSchema: assessOutputSchema,
    build: (deps: TDeps) => {
      return tool({
        description,
        inputSchema: assessInputSchema,
        execute: (args: AssessArgs): Promise<AssessResult> => {
          return assess(args, opts.getDecider(deps))
        },
      })
    },
  }
}
