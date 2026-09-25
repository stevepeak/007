import { resolveBinding } from '../binding'
import {
  chunkQuestions,
  resolveVerdicts,
  verdictReasoning,
  type Decider,
  type DecisionAnswer,
  type DecisionNode,
  type DecisionNodeQuestion,
  type DecisionQuestion,
  type DecisionUsage,
  type DecisionVerdict,
} from '../graph'

// Probabilistic judgment. The Decision node hands one state and every one of its
// questions to a decider in a SINGLE call and turns the returned distributions
// into verdicts. It does not route — a Branch or Switch downstream reads
// `answers.<questionId>.value` and routes on it.
//
// Where it sits among its siblings:
//   • Branch   — code predicate, and the router. Free, exact, blind to meaning.
//   • Switch   — code predicate, multi-way. Same.
//   • Agent    — a whole generation per gate, answering in prose we then read.
//   • Decision — one provider call for N questions, answering in probabilities.
//
// Like Branch and Switch it does NOT forward its input: the output IS the
// judgment, so a downstream ref to a Decision yields the answers. And like them
// it resolves its subject through an explicit `source` ref rather than taking
// whatever arrived.

export type DecisionNodeResult = {
  /** Verdict per question id — the node's output, and what refs address. */
  answers: Record<string, DecisionVerdict>
  /** How every question was answered, one line, for the run record. */
  reasoning: string
  /** What actually answered, for the run record. */
  modelId?: string
  usage?: DecisionUsage
}

export type DecisionNodeMeta = {
  modelId?: string
  /** Question ids asked, in order — enough to read a step without its config. */
  questionIds: string[]
  usage?: DecisionUsage
}

export type ExecuteDecisionNodeArgs = {
  node: DecisionNode
  /** The prior node's output — judged when the node has no `source` ref. */
  input: unknown
  nodeOutputs: Map<string, unknown>
  /** Resolves the node's `modelId` to a decider. Bound by the dispatcher. */
  getDecider: (modelId: string) => Decider
  /**
   * Deep-rehydrates blob-ref values before the state is judged. Without it a
   * spilled upstream output (a whole extracted document, which is exactly the
   * kind of thing worth judging) would be sent as its POINTER — and the provider
   * would confidently answer questions about a JSON blob reference. Same reason
   * Branch and Switch take one, with more at stake: a 64K-token state is far
   * likelier to have spilled than a value being compared for equality.
   */
  rehydrate?: (value: unknown) => Promise<unknown>
}

/**
 * The choices for one question, from wherever they come from.
 *
 * `choicesSource` set → the list is an upstream node's array output, resolved
 * per run: "which of these documents is the lease" cannot be authored, because
 * the documents are whatever the run found. Unset → the authored list.
 *
 * Element shapes, in the order an author is likely to produce them: a bare
 * string is its own key; an object names its `key`, or is keyed off its `label`
 * when it has none (the shape a tool that returns `{ label, description }` rows
 * gives you). Anything else is a real error rather than a silent `[object
 * Object]` option the provider is then asked to choose between.
 */
function resolveChoiceSource(
  value: unknown,
  question: DecisionNodeQuestion,
  nodeId: string,
): { key: string; description?: string }[] {
  const where = `Decision node ${nodeId} question '${question.id}'`
  if (!Array.isArray(value)) {
    throw new TypeError(
      `${where} takes its choices from an upstream value, but that value is ${value === undefined ? 'missing' : `a ${typeof value}`}, not a list.`,
    )
  }
  const seen = new Set<string>()
  return value.map((item, i) => {
    const raw =
      typeof item === 'string' || typeof item === 'number'
        ? { key: String(item) }
        : item && typeof item === 'object'
          ? (item as { key?: unknown; label?: unknown; description?: unknown })
          : null
    if (!raw) {
      throw new Error(
        `${where} got ${item === null ? 'null' : `a ${typeof item}`} as choice ${i + 1}; each choice must be a string or an object with a key or label.`,
      )
    }
    const key =
      typeof raw.key === 'string' && raw.key.trim()
        ? raw.key.trim()
        : typeof raw.label === 'string' && raw.label.trim()
          ? raw.label.trim()
          : ''
    if (!key) {
      throw new Error(
        `${where} got a choice with no key or label at position ${i + 1}.`,
      )
    }
    // Duplicates would make the returned distribution ambiguous — two entries
    // under one key, and no way to say which the model meant.
    if (seen.has(key)) {
      throw new Error(`${where} got the choice '${key}' twice.`)
    }
    seen.add(key)
    return {
      key,
      description:
        typeof raw.description === 'string' ? raw.description : undefined,
    }
  })
}

/**
 * Translate an authored question into the provider-facing shape.
 *
 * The graph schema stores questions FLAT (one `choices` array, since the editor
 * and the MCP tools all write through that schema); the provider contract is a
 * discriminated union. This is the one place the two meet, and it is where a
 * `category` with no options becomes a real error rather than a request that
 * returns a distribution over nothing — including the dynamic case, where the
 * list only exists once the run has produced it.
 */
function toProviderQuestion(
  question: DecisionNodeQuestion,
  nodeId: string,
  dynamicChoices?: { key: string; description?: string }[],
): DecisionQuestion {
  const prompt = question.prompt.trim()
  if (!prompt) {
    throw new Error(
      `Decision node ${nodeId} question '${question.id}' has no prompt — there is nothing to judge.`,
    )
  }
  if (question.type === 'boolean') {
    return { id: question.id, type: 'boolean', prompt }
  }
  const choices =
    dynamicChoices ??
    question.choices.map((c) => ({ key: c.key, description: c.description }))
  if (choices.length < 2) {
    throw new Error(
      dynamicChoices
        ? `Decision node ${nodeId} question '${question.id}' takes its choices from an upstream value, which arrived with ${choices.length} — it needs at least two.`
        : `Decision node ${nodeId} question '${question.id}' is a ${question.type} question with ${choices.length} choice(s); it needs at least two.`,
    )
  }
  return question.type === 'category'
    ? { id: question.id, type: 'category', prompt, options: choices }
    : { id: question.id, type: 'scale', prompt, levels: choices }
}

/** The per-question thresholds, keyed by id, for `resolveVerdicts`. */
function thresholdFor(
  questions: readonly DecisionNodeQuestion[],
  id: string,
): number | undefined {
  return questions.find((q) => q.id === id)?.threshold
}

export async function executeDecisionNode(
  deps: ExecuteDecisionNodeArgs,
): Promise<DecisionNodeResult> {
  const { node, input, nodeOutputs, getDecider, rehydrate } = deps
  const { modelId, source, questions } = node.config

  if (!modelId) {
    throw new Error(
      `Decision node ${node.id} has no decision model selected. Pick one in the node's inspector.`,
    )
  }
  if (questions.length === 0) {
    throw new Error(
      `Decision node ${node.id} asks no questions. Add at least one in the node's inspector.`,
    )
  }

  const raw = source
    ? resolveBinding(source, nodeOutputs, { nodeId: node.id, name: 'source' })
    : input
  const state = rehydrate ? await rehydrate(raw) : raw

  // A question's choices may themselves be upstream data, so this resolves
  // before the call rather than inside the map: a spilled list has to be
  // rehydrated first, exactly like the judged state above.
  const providerQuestions: DecisionQuestion[] = []
  for (const q of questions) {
    if (!q.choicesSource || q.type === 'boolean') {
      providerQuestions.push(toProviderQuestion(q, node.id))
      continue
    }
    const listRaw = resolveBinding(q.choicesSource, nodeOutputs, {
      nodeId: node.id,
      name: `question '${q.id}' choices`,
    })
    const list = rehydrate ? await rehydrate(listRaw) : listRaw
    providerQuestions.push(
      toProviderQuestion(q, node.id, resolveChoiceSource(list, q, node.id)),
    )
  }
  const decide = getDecider(modelId)

  // Chunked when the provider caps its batch size. Sequential rather than
  // parallel on purpose: the chunks share one rate-limit window, and firing them
  // together is the surest way to spend it — the whole point of batching is
  // fewer requests, not the same requests sooner.
  const chunks = chunkQuestions(providerQuestions, decide.maxQuestionsPerCall)
  const answers: DecisionAnswer[] = []
  let answeredModelId: string | undefined
  const usage: DecisionUsage = {}
  for (const chunk of chunks) {
    const response = await decide({ state, questions: chunk })
    answers.push(...response.answers)
    answeredModelId ??= response.modelId
    usage.inputTokens =
      (usage.inputTokens ?? 0) + (response.usage?.inputTokens ?? 0)
    usage.outputTokens =
      (usage.outputTokens ?? 0) + (response.usage?.outputTokens ?? 0)
  }

  // Per-question thresholds, so each boolean can carry its own cut. Resolved one
  // question at a time rather than with a single shared threshold, because "does
  // this need a lawyer" and "is this spam" have no business sharing a cut.
  const verdicts: Record<string, DecisionVerdict> = {}
  for (const question of providerQuestions) {
    const one = resolveVerdicts([question], answers, {
      threshold: thresholdFor(questions, question.id),
    })
    Object.assign(verdicts, one)
  }

  return {
    answers: verdicts,
    reasoning: providerQuestions
      .map((q) => verdictReasoning(verdicts[q.id]))
      .join(' · '),
    modelId: answeredModelId ?? modelId,
    usage,
  }
}

/** The meta recorded on the node's step — see {@link DecisionNodeMeta}. */
export function decisionNodeMeta(
  node: DecisionNode,
  result: DecisionNodeResult,
): DecisionNodeMeta {
  return {
    modelId: result.modelId,
    questionIds: node.config.questions.map((q) => q.id),
    usage: result.usage,
  }
}
