import { generateObject, type LanguageModel } from 'ai'
import { z } from 'zod'

import {
  questionChoices,
  type Decider,
  type DecisionAnswer,
  type DecisionDistributionEntry,
  type DecisionQuestion,
  type DecisionRequest,
  type DecisionResponse,
} from './decision'
import { strictSchema } from './strict-schema'

/**
 * A {@link Decider} built on any chat model, via structured output.
 *
 * This exists so the decision seam is portable in fact and not just in type:
 * a host with no purpose-built decision endpoint still gets decision nodes, and
 * the contract in `decision.ts` is proven satisfiable by something that isn't
 * the vendor it was designed against. A contract with exactly one possible
 * implementation is a vendor API wearing a hat.
 *
 * It is honestly worse than a native decider — slower, one generation per
 * batch, and its numbers are a model's self-report rather than a calibrated
 * distribution. A host offering it should mark its catalog entry
 * `calibrated: false` and `kind: 'chat-emulated'` so an author choosing a
 * confidence threshold knows what they are thresholding.
 *
 * ── Why one flat answer shape ────────────────────────────────────────────────
 * The three question types beg for a discriminated union, and a union is the
 * one thing the strict structured-output dialect cannot express: zod emits
 * `oneOf`, providers drop it silently, and the result is unconstrained prose
 * with no error anywhere (see `strict-schema.ts`). So every question — boolean
 * included — is answered with the SAME shape: a weight per named key. A boolean
 * is simply a question whose keys are `yes` and `no`.
 *
 * ── Why weights rather than probabilities ────────────────────────────────────
 * Models are poor at emitting numbers that sum to 1 and good at relative
 * scoring. Asking for probabilities directly yields sets that sum to 0.8 or
 * 1.3, and normalizing those silently is indistinguishable from normalizing a
 * genuine distribution. Asking for weights makes the normalization explicit and
 * correct by construction.
 */

/**
 * The per-question answer. Key order is load-bearing, exactly as it is for the
 * eval judge: `generateObject` emits keys in schema order, so `reasoning` is
 * declared before `weights` to make the model argue before it scores. Reversed,
 * the numbers come out first and the reasoning is a rationalization of them.
 */
const chatAnswerSchema = z.object({
  id: z.string().describe('The question id, copied exactly.'),
  reasoning: z
    .string()
    .describe('One or two sentences weighing the evidence. Write this first.'),
  weights: z
    .array(
      z.object({
        key: z.string().describe('One of the keys offered for this question.'),
        weight: z
          .number()
          .describe(
            'How much this key is supported, 0-100. Spread the weight to show genuine uncertainty; do not put 100 on one key unless the state really is unambiguous.',
          ),
      }),
    )
    .describe('One entry per key offered, including the ones you rule out.'),
})

const chatDecisionSchema = z.object({
  answers: z
    .array(chatAnswerSchema)
    .describe('Exactly one entry per question, in the order asked.'),
})

const SYSTEM_PROMPT =
  'You are a judgment engine. You are given a STATE and a list of QUESTIONS, and you answer every question against that state alone. Judge only what the state supports — do not invent facts, and do not answer from general knowledge about how such situations usually go. Each question offers a fixed set of keys; distribute 0-100 weight across those keys to show how strongly the state supports each one. Genuine uncertainty must show up as spread weight, not as a confident pick.'

/** The keys a question is answered over — `yes`/`no` for a boolean. */
function answerKeys(question: DecisionQuestion): string[] {
  if (question.type === 'boolean') return ['yes', 'no']
  return questionChoices(question).map((c) => c.key)
}

/** Render one question, keys and all, as the model will see it. */
function renderQuestion(question: DecisionQuestion): string {
  const lines = [`- id: ${question.id}`, `  question: ${question.prompt}`]
  if (question.type === 'boolean') {
    lines.push('  keys: yes, no')
    const considerations = Object.entries(question.considerations ?? {})
    for (const [name, meaning] of considerations) {
      lines.push(`  consider ${name}: ${meaning}`)
    }
    return lines.join('\n')
  }
  if (question.type === 'scale') {
    lines.push('  keys (ordered lowest to highest):')
  } else {
    lines.push('  keys:')
  }
  for (const choice of questionChoices(question)) {
    lines.push(
      `    ${choice.key}${choice.description ? ` — ${choice.description}` : ''}`,
    )
  }
  return lines.join('\n')
}

function buildPrompt(request: DecisionRequest): string {
  const state =
    typeof request.state === 'string'
      ? request.state
      : JSON.stringify(request.state, null, 2)
  const questions = request.questions.map(renderQuestion).join('\n')
  return `STATE:\n${state}\n\nQUESTIONS:\n${questions}`
}

/**
 * Weights → a probability distribution over the question's own keys.
 *
 * Every key the question declared appears, so a model that only scored the
 * options it liked doesn't produce a short distribution (which would misalign a
 * scale's indices and measure confidence against a runner-up that isn't there).
 * Negative weights are floored at 0; an all-zero set falls back to uniform,
 * since "the model told us nothing" is honestly maximum uncertainty and not a
 * reason to fail the node.
 */
function toDistribution(
  keys: readonly string[],
  weights: readonly { key: string; weight: number }[],
): DecisionDistributionEntry[] {
  const byKey = new Map(weights.map((w) => [w.key, w.weight]))
  const raw = keys.map((key) => {
    const weight = byKey.get(key)
    return Number.isFinite(weight) ? Math.max(0, weight as number) : 0
  })
  const total = raw.reduce((sum, w) => sum + w, 0)
  if (total <= 0) {
    return keys.map((key) => ({ key, probability: 1 / keys.length }))
  }
  return keys.map((key, i) => ({ key, probability: raw[i] / total }))
}

export type ChatDeciderOptions = {
  /** The chat model to judge with. */
  model: LanguageModel
  /** Reported back on the response, for the run record. */
  modelId?: string
  /** Forwarded to `generateObject`; composes with the node's own budget. */
  abortSignal?: AbortSignal
}

export function createChatDecider(options: ChatDeciderOptions): Decider {
  return async (request: DecisionRequest): Promise<DecisionResponse> => {
    if (request.questions.length === 0) {
      return { modelId: options.modelId, answers: [] }
    }

    const { object, usage } = await generateObject({
      model: options.model,
      schema: strictSchema(chatDecisionSchema),
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(request),
      abortSignal: options.abortSignal,
    })

    const byId = new Map(object.answers.map((a) => [a.id, a]))
    const answers: DecisionAnswer[] = request.questions.map((question) => {
      const keys = answerKeys(question)
      // A question the model skipped gets a uniform distribution rather than an
      // omission. `resolveVerdicts` throws on a missing answer — correct for a
      // provider that silently dropped a question, but here we KNOW what was
      // asked, and "no signal" is better expressed as maximum uncertainty than
      // as a failed node. The margin confidence will read 0 and an escalation
      // threshold will catch it, which is the right outcome.
      const weights = byId.get(question.id)?.weights ?? []
      const distribution = toDistribution(keys, weights)
      if (question.type === 'boolean') {
        const yes = distribution.find((d) => d.key === 'yes')?.probability ?? 0
        return { id: question.id, type: 'boolean', probability: yes }
      }
      return { id: question.id, type: question.type, distribution }
    })

    return {
      modelId: options.modelId,
      answers,
      // Deliberately no `confidence` on any answer: a chat model's stated
      // confidence is a guess about a guess, and letting it through would make
      // this provider's numbers non-comparable with a calibrated one's. The
      // engine derives the margin instead — see `distributionConfidence`.
      usage: {
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
      },
    }
  }
}
