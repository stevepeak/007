import {
  buildProviderQuestion,
  chunkQuestions,
  resolveVerdicts,
  verdictReasoning,
  type Decider,
  type DecisionAnswer,
  type DecisionQuestion,
  type DecisionUsage,
  type DecisionVerdict,
} from './decision'
import {
  decisionAgentProviderChoices,
  type DecisionAgentConfig,
  type DecisionAgentQuestion,
  type DecisionRule,
  type DecisionRuleCondition,
} from './decision-agent-schema'
import { substitutePromptVariables } from './prompt-variables'

// Running a decision agent — the direct invoke path.
//
// A decision agent is ONE provider call. No tool loop, no graph, no run
// manifest, no durability question, and so no reason to go through the engine's
// executor: the playground, the eval runner and the MCP preview all call this
// function and get the same answer the same way.
//
// That is a real divergence from generation agents, whose evals run through a
// hidden single-agent wrapper workflow (`eval/wrapper.ts`) precisely because
// they need the executor's tool loop, step recording and manifest freezing. A
// decision agent needs none of it, and wrapping it in a graph to get a `wf_run`
// would buy a trace of one node and cost an executor, a Durable Object and a
// minute of latency per eval cell.

/** What a decision agent answers with. Its whole output contract. */
export type DecisionAgentResult = {
  /** The verdict the first matching rule named. Never null — a fallback is required. */
  verdict: string
  /** Which rule fired and what it read: `rule 1 (is_urgent 0.82, matter outage)`. */
  because: string
  /** The raw judgment, per question id — distributions, thresholds and all. */
  answers: Record<string, DecisionVerdict>
  /**
   * What ACTUALLY answered, echoed by the provider.
   *
   * Not the id we asked with, and the difference is the point: `jev-latest`
   * floats, so a decision agent can be fully version-pinned in 007 and still
   * change behaviour with no version bump anywhere. Recording the echo is what
   * lets an eval report attribute a moved score to the model rather than to the
   * questions.
   */
  modelId?: string
  usage?: DecisionUsage
}

export type RunDecisionAgentInput = {
  config: DecisionAgentConfig
  /** The shared context every question is judged against. Any JSON value. */
  state: unknown
  /** Resolves `config.modelId` to a decider. `WfSdkConfig.getDecider`, bound. */
  getDecider: (modelId: string) => Decider
  /**
   * Values for `${name}` tokens in the question prompts and considerations.
   * The same bag shape a generation agent's prompts interpolate from, so a Goal
   * can parameterise a question the way it parameterises a prompt.
   */
  variables?: Record<string, string>
  /** Deep-rehydrates blob-ref values in `state` before it is judged. */
  rehydrate?: (value: unknown) => Promise<unknown>
}

/** `${var}` substitution over a question's author-written text. */
function interpolateQuestion(
  question: DecisionAgentQuestion,
  variables: Record<string, string> | undefined,
): DecisionAgentQuestion {
  if (!variables || Object.keys(variables).length === 0) return question
  const considerations: Record<string, string> = {}
  for (const [key, text] of Object.entries(question.considerations)) {
    considerations[key] = substitutePromptVariables(text, variables)
  }
  return {
    ...question,
    prompt: substitutePromptVariables(question.prompt, variables),
    considerations,
  }
}

/** The provider-facing question list, in the config's order. */
export function decisionAgentQuestions(
  config: Pick<DecisionAgentConfig, 'questions'>,
  variables?: Record<string, string>,
): DecisionQuestion[] {
  return config.questions.map((raw) => {
    const question = interpolateQuestion(raw, variables)
    return buildProviderQuestion(
      {
        id: question.id,
        type: question.type,
        prompt: question.prompt,
        considerations: question.considerations,
      },
      decisionAgentProviderChoices(question),
      `Decision agent question '${question.id}'`,
    )
  })
}

/**
 * Does one condition hold against one verdict?
 *
 * Scale comparisons go through the question's declared level ORDER, not the
 * weighted index and not the provider's labels. The index is a float across a
 * scale whose length the rule doesn't know; the labels collide when two levels
 * share a description. The position in `question.levels` is the only thing that
 * means the same to the author and to the answer.
 */
function conditionHolds(
  condition: DecisionRuleCondition,
  verdict: DecisionVerdict | undefined,
  question: DecisionAgentQuestion | undefined,
): boolean {
  if (!verdict || !question) return false
  switch (condition.op) {
    case 'gte':
      return (
        verdict.type === 'boolean' &&
        condition.probability != null &&
        verdict.probability >= condition.probability
      )
    case 'lt':
      return (
        verdict.type === 'boolean' &&
        condition.probability != null &&
        verdict.probability < condition.probability
      )
    case 'is':
      return verdict.type === 'boolean' && verdict.value === condition.yes
    case 'equals':
      return verdict.type === 'category' && verdict.value === condition.keys[0]
    case 'in':
      return verdict.type === 'category' && condition.keys.includes(verdict.value)
    case 'atLeast':
    case 'atMost': {
      if (verdict.type !== 'scale') return false
      const order = question.choices.map((c) => c.key)
      const want = order.indexOf(condition.keys[0] ?? '')
      const got = order.indexOf(verdict.level)
      if (want < 0 || got < 0) return false
      return condition.op === 'atLeast' ? got >= want : got <= want
    }
  }
}

/** How a condition read, for the `because` line: `is_urgent 0.82`. */
function conditionTrace(
  condition: DecisionRuleCondition,
  verdict: DecisionVerdict | undefined,
): string {
  if (!verdict) return `${condition.questionId} (unanswered)`
  if (verdict.type === 'boolean') {
    return `${verdict.id} ${verdict.probability.toFixed(2)}`
  }
  if (verdict.type === 'category') return `${verdict.id} ${verdict.value}`
  return `${verdict.id} ${verdict.level} (${verdict.value.toFixed(2)})`
}

export type DecisionRollup = {
  verdict: string
  because: string
  /** The rule that fired, for a caller that wants to link to it. */
  ruleId: string
}

/**
 * Apply the ordered rules to a set of verdicts — the policy layer Jev requires
 * its caller to own, and the step that makes the output a DECISION rather than
 * a measurement.
 *
 * First match wins. The fallback is required by the schema, so the only way to
 * reach the end of the list is a config that was saved before the rule existed
 * or hand-written past the schema; that throws rather than returning a null
 * verdict, because every consumer downstream is written against a total value.
 */
export function applyDecisionRules(
  rules: readonly DecisionRule[],
  answers: Record<string, DecisionVerdict>,
  questions: readonly DecisionAgentQuestion[],
): DecisionRollup {
  const byId = new Map(questions.map((q) => [q.id, q]))
  for (const [index, rule] of rules.entries()) {
    const holds = rule.conditions.every((condition) =>
      conditionHolds(condition, answers[condition.questionId], byId.get(condition.questionId)),
    )
    if (!holds) continue
    const trace = rule.conditions
      .map((c) => conditionTrace(c, answers[c.questionId]))
      .join(', ')
    return {
      verdict: rule.verdict,
      ruleId: rule.id,
      because: trace
        ? `rule ${index + 1} (${trace})`
        : `rule ${index + 1} (fallback)`,
    }
  }
  throw new Error(
    'No rule matched and this decision agent has no fallback rule, so there is no verdict. Add a final rule with no conditions.',
  )
}

/**
 * Judge `state` with the agent's questions and roll the answers up into one
 * verdict. The whole of what a decision agent does.
 */
export async function runDecisionAgent(
  input: RunDecisionAgentInput,
): Promise<DecisionAgentResult> {
  const { config, getDecider, variables } = input
  if (!config.modelId) {
    throw new Error(
      'This decision agent has no decision model selected. Pick one in the editor.',
    )
  }
  if (config.questions.length === 0) {
    throw new Error(
      'This decision agent asks no questions. Add at least one in the editor.',
    )
  }
  if (config.rules.length === 0) {
    throw new Error(
      'This decision agent has no rules, so its answers roll up to no verdict. Add at least an unconditional fallback.',
    )
  }

  const state = input.rehydrate ? await input.rehydrate(input.state) : input.state
  const questions = decisionAgentQuestions(config, variables)
  const decide = getDecider(config.modelId)

  // Chunked when the provider caps its batch size, sequentially: the chunks
  // share one rate-limit window, and firing them together spends it.
  const answers: DecisionAnswer[] = []
  let answeredModelId: string | undefined
  const usage: DecisionUsage = {}
  for (const chunk of chunkQuestions(questions, decide.maxQuestionsPerCall)) {
    const response = await decide({ state, questions: chunk })
    answers.push(...response.answers)
    answeredModelId ??= response.modelId
    usage.inputTokens =
      (usage.inputTokens ?? 0) + (response.usage?.inputTokens ?? 0)
    usage.outputTokens =
      (usage.outputTokens ?? 0) + (response.usage?.outputTokens ?? 0)
  }

  // Per-question thresholds: "is this urgent" and "is this spam" have no
  // business sharing a cut, so each question's own is applied.
  const verdicts: Record<string, DecisionVerdict> = {}
  for (const question of questions) {
    Object.assign(
      verdicts,
      resolveVerdicts([question], answers, {
        threshold: config.questions.find((q) => q.id === question.id)?.threshold,
      }),
    )
  }

  const rollup = applyDecisionRules(config.rules, verdicts, config.questions)
  return {
    verdict: rollup.verdict,
    because: rollup.because,
    answers: verdicts,
    modelId: answeredModelId ?? config.modelId,
    usage,
  }
}

/** One-line trace of every answer, for a run record or a playground footer. */
export function decisionAgentReasoning(result: DecisionAgentResult): string {
  return Object.values(result.answers).map(verdictReasoning).join(' · ')
}
