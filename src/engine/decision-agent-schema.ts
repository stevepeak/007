import { z } from 'zod'

import type { AgentConfig } from './agent-config-schema'
import { DECISION_QUESTION_TYPES } from './decision'
import { inferPromptVariables } from './prompt-variables'

// The versioned behavior of a DECISION agent (`wf_agent.kind = 'decision'`):
// the question set a decider judges a state against, plus the policy that turns
// those answers into one verdict.
//
// It is a sibling of `agent-config-schema.ts`, not an extension of it. The two
// share no field — a decision agent has no prompt, no user turn, no tools, no
// turn limit, no token budget, no sub-agents, no web search and no reasoning
// toggle — so folding both through one schema would produce a type with two
// disjoint halves and a `kind` nobody could forget to check. The discriminator
// lives on the ENTITY (`agent-kind.ts`), which is where the choice is actually
// made and why it is immutable.
//
// ── Why this exists at all ──────────────────────────────────────────────────
// The decision primitive shipped inline on a workflow node (`decisionNodeSchema`
// in `graph-schema.ts`): a question set authored per placement, with no entity
// to version, no playground to exercise it and — the one that matters — no eval
// target. "Did that change to the question wording make the decisions better or
// worse?" was unanswerable. Promoting the question set into the agents surface
// buys it the whole machinery agents already have: entity + draft + versions,
// float-to-latest, the change log, the playground, MCP, and eval sets.
//
// ── The rollup, and why it belongs HERE ─────────────────────────────────────
// A decider deliberately returns no verdict — see `decision.ts`: where to cut is
// policy, and policy is the caller's. Left to a graph, that policy would be
// scattered across per-question thresholds and whatever Branch/Switch nodes
// happen to read the answers, which means the thing an eval could grade is the
// MEASUREMENT, not the decision. Rules live on the agent because they are
// versioned alongside the questions they read, and because they are what makes
// the output one gradeable value.
//
// A rollup ANSWERS, it does not ROUTE. Routing is Branch's and Switch's job: a
// Switch downstream binds the agent node's `verdict`.

// ── Questions ───────────────────────────────────────────────────────────────

/** One option (a category) or one level (a point on a scale). */
export const decisionAgentChoiceSchema = z.object({
  // The machine key: what a verdict reports, what a rule compares against, and
  // what an eval expectation names. Derived from the label by the editor, then
  // held still — renaming the label must not silently repoint a rule.
  key: z.string().min(1),
  // Human text. Also what the provider is shown, since a machine key reads to a
  // model exactly as badly as it looks (see `description` below).
  label: z.string().optional(),
  // Explicit provider-facing wording, when the label is too terse to judge on.
  // Unset falls back to the label — see `decisionAgentProviderChoices`.
  description: z.string().optional(),
})
export type DecisionAgentChoice = z.infer<typeof decisionAgentChoiceSchema>

/**
 * One authored question. FLAT rather than a discriminated union per type, for
 * the same reason `decisionQuestionSchema` is: the editor's form and the MCP
 * tools both write through this schema, and a union here fans out into every
 * one of those surfaces for no gain. The type-specific rules are checked in
 * {@link decisionAgentConfigIssues}, which can say "a category question needs
 * options" far better than a union mismatch can.
 */
export const decisionAgentQuestionSchema = z.object({
  // Stable identity: the key the answer lands under (`answers.<id>`), what a
  // rule names, and what an eval expectation addresses.
  id: z.string().min(1),
  type: z.enum(DECISION_QUESTION_TYPES).default('boolean'),
  prompt: z.string().default(''),
  // `boolean` only: named things to weigh, e.g.
  // `{ overdue: 'No reply in 48h' }`. This reaches Jev's noul `criteria`
  // through the host adapter, which has read it since ART-231 — but until now
  // NO authoring surface could set it, so a live provider feature was
  // unreachable from the product. It is within-question structure, which is
  // exactly where the matrix is allowed to get richer; between-question
  // dependencies are ruled out on Jev's contract (see the ticket's non-goals).
  considerations: z.record(z.string(), z.string()).default({}),
  // `category`: the options to choose between. `scale`: the ordered levels,
  // LOWEST FIRST — the order IS the scale, so reordering changes every answer's
  // weighted index and every `atLeast`/`atMost` rule that reads it.
  choices: z.array(decisionAgentChoiceSchema).default([]),
  // `boolean` only: the cut at which the answer counts as yes. Policy, and the
  // author's — see `decision.ts`. A rule's `is` condition reads this; a rule's
  // `gte`/`lt` names its own cut instead.
  threshold: z.number().min(0).max(1).optional(),
})
export type DecisionAgentQuestion = z.infer<typeof decisionAgentQuestionSchema>

/**
 * A question's choices in the provider's vocabulary.
 *
 * `description ?? label ?? key` — the fallback chain matters. The Jev adapter
 * sends `description ?? key` as the criterion text, so a question authored with
 * labels alone would have its options described to the model as `needs_review`
 * and `auto_reply`. The label is the text a human wrote to mean the option; it
 * is strictly better than the slug derived from it.
 */
export function decisionAgentProviderChoices(
  question: Pick<DecisionAgentQuestion, 'choices'>,
): { key: string; description?: string }[] {
  return question.choices.map((c) => ({
    key: c.key,
    description: c.description?.trim() || c.label?.trim() || undefined,
  }))
}

// ── Rules: the rollup ───────────────────────────────────────────────────────

/**
 * How one condition compares one question's answer.
 *
 * Per question type, and nothing crosses over — a `gte` against a category
 * answer is a validation error, not a coincidentally-false comparison:
 *
 *   • `boolean`  — `gte` / `lt` against an explicit probability cut, or `is`
 *     (yes/no) which reads the question's OWN `threshold`.
 *   • `category` — `equals` one key, or `in` a set of them.
 *   • `scale`    — `atLeast` / `atMost` a level, compared ORDINALLY through the
 *     question's declared level order. Not through the provider's returned
 *     labels: two levels may share a description, and `decider.ts:toAnswer`
 *     maps by position for exactly this reason.
 */
export const DECISION_CONDITION_OPS = [
  'gte',
  'lt',
  'is',
  'equals',
  'in',
  'atLeast',
  'atMost',
] as const
export type DecisionConditionOp = (typeof DECISION_CONDITION_OPS)[number]

/** The ops each question type accepts — the single source both the validator
 *  and the editor's op picker read, so neither can offer what the other rejects. */
export const DECISION_CONDITION_OPS_BY_TYPE: Record<
  (typeof DECISION_QUESTION_TYPES)[number],
  readonly DecisionConditionOp[]
> = {
  boolean: ['gte', 'lt', 'is'],
  category: ['equals', 'in'],
  scale: ['atLeast', 'atMost'],
}

export const decisionRuleConditionSchema = z.object({
  /** The question this reads. Must name one the config declares. */
  questionId: z.string().min(1),
  op: z.enum(DECISION_CONDITION_OPS).default('is'),
  /** `gte` / `lt`: the probability cut, 0–1. */
  probability: z.number().min(0).max(1).optional(),
  /** `is`: which side of the question's own threshold. */
  yes: z.boolean().optional(),
  /**
   * `equals` / `atLeast` / `atMost`: one choice key (the first entry). `in`:
   * the set. One field rather than three because a condition changes op far
   * more often than it changes question, and three fields would leave two of
   * them stale behind every such change.
   */
  keys: z.array(z.string().min(1)).default([]),
})
export type DecisionRuleCondition = z.infer<typeof decisionRuleConditionSchema>

/**
 * One rule: every condition must hold (AND), and the FIRST rule that matches
 * names the verdict.
 *
 * AND-only within a rule, deliberately. First-match-wins over an ordered list
 * already expresses OR — two rules naming the same verdict — while staying
 * readable, lintable, and explainable to the person whose request got escalated.
 * Nested boolean algebra would be none of those.
 *
 * A rule with NO conditions always matches. That is how the required fallback
 * is spelled, and why only the last rule may have one (see the validator).
 */
export const decisionRuleSchema = z.object({
  id: z.string().min(1),
  /** The verdict this rule names. Must be one of the declared `verdicts`. */
  verdict: z.string().min(1),
  conditions: z.array(decisionRuleConditionSchema).default([]),
})
export type DecisionRule = z.infer<typeof decisionRuleSchema>

// ── The config ──────────────────────────────────────────────────────────────

const decisionAgentConfigObjectSchema = z.object({
  /**
   * Composite `providerId:modelId`, resolved through `WfSdkConfig.getDecider`.
   *
   * DECIDERS ONLY — there is no `createChatDecider` fallback for this type. A
   * deployment with no decision provider simply cannot use it, which is the
   * same empty state `eval-check-config-decision.tsx` already shows for the
   * decision judge. A chat model dressed up as a decider would make every
   * threshold on the agent mean something different, silently.
   */
  modelId: z.string().min(1),
  questions: z.array(decisionAgentQuestionSchema).default([]),
  /**
   * The declared outcome set. Explicit rather than derived from the rules so a
   * downstream consumer can enumerate the cases before any rule has been
   * written, and so a typo in a rule's verdict is an error rather than a new
   * outcome nobody handles.
   */
  verdicts: z.array(z.string().min(1)).default([]),
  /** Ordered; first match wins; the last one must be an unconditional fallback. */
  rules: z.array(decisionRuleSchema).default([]),
})

/**
 * Everything wrong with a config, as author-facing sentences.
 *
 * Separate from the zod schema (rather than a `superRefine`) because the editor
 * needs to RENDER these while the author is halfway through writing them — a
 * half-built config must still save as a draft. `decisionAgentConfigSchema`
 * enforces the subset that would make a run impossible; this reports everything.
 */
export function decisionAgentConfigIssues(config: {
  modelId?: string
  questions: readonly DecisionAgentQuestion[]
  verdicts: readonly string[]
  rules: readonly DecisionRule[]
}): string[] {
  const issues: string[] = []
  const byId = new Map(config.questions.map((q) => [q.id, q]))

  if (!config.modelId) issues.push('Pick a decision model.')
  if (config.questions.length === 0) {
    issues.push('Ask at least one question — there is nothing to judge yet.')
  }

  const seen = new Set<string>()
  for (const question of config.questions) {
    if (seen.has(question.id)) {
      issues.push(`Two questions are both called '${question.id}'.`)
    }
    seen.add(question.id)
    if (!question.prompt.trim()) {
      issues.push(`Question '${question.id}' has no prompt.`)
    }
    if (question.type !== 'boolean' && question.choices.length < 2) {
      issues.push(
        `Question '${question.id}' is a ${question.type} question with ${question.choices.length} choice(s); it needs at least two.`,
      )
    }
    const keys = new Set<string>()
    for (const choice of question.choices) {
      if (keys.has(choice.key)) {
        issues.push(
          `Question '${question.id}' offers the choice '${choice.key}' twice.`,
        )
      }
      keys.add(choice.key)
    }
  }

  if (config.verdicts.length === 0) {
    issues.push('Declare the verdicts this agent can reach.')
  }
  const verdicts = new Set(config.verdicts)

  if (config.rules.length === 0) {
    issues.push('Add at least one rule — an unconditional fallback, at minimum.')
  }
  config.rules.forEach((rule, index) => {
    const where = `Rule ${index + 1}`
    if (!verdicts.has(rule.verdict)) {
      issues.push(
        `${where} names the verdict '${rule.verdict}', which is not in the declared set.`,
      )
    }
    const isLast = index === config.rules.length - 1
    if (rule.conditions.length === 0 && !isLast) {
      issues.push(
        `${where} has no conditions, so it always matches and every rule below it is unreachable. Only the last rule may be the fallback.`,
      )
    }
    if (isLast && rule.conditions.length > 0) {
      issues.push(
        'The last rule must be an unconditional fallback, so every state reaches a verdict. Add one with no conditions.',
      )
    }
    for (const condition of rule.conditions) {
      const question = byId.get(condition.questionId)
      if (!question) {
        issues.push(
          `${where} reads a question called '${condition.questionId}', which this agent does not ask.`,
        )
        continue
      }
      const allowed = DECISION_CONDITION_OPS_BY_TYPE[question.type]
      if (!allowed.includes(condition.op)) {
        issues.push(
          `${where} compares '${question.id}' with '${condition.op}', which a ${question.type} question does not support.`,
        )
        continue
      }
      if (
        (condition.op === 'gte' || condition.op === 'lt') &&
        condition.probability == null
      ) {
        issues.push(`${where} needs a probability to compare '${question.id}' against.`)
      }
      if (condition.op === 'is' && condition.yes == null) {
        issues.push(`${where} needs to say whether '${question.id}' should be yes or no.`)
      }
      if (condition.op !== 'gte' && condition.op !== 'lt' && condition.op !== 'is') {
        if (condition.keys.length === 0) {
          issues.push(`${where} needs a choice to compare '${question.id}' against.`)
        }
        const known = new Set(question.choices.map((c) => c.key))
        for (const key of condition.keys) {
          if (!known.has(key)) {
            issues.push(
              `${where} compares '${question.id}' against '${key}', which is not one of its choices.`,
            )
          }
        }
      }
    }
  })

  return issues
}

/**
 * The saved shape.
 *
 * The refinement is deliberately NARROWER than {@link decisionAgentConfigIssues}
 * — it rejects only what makes the config incoherent as a data structure (a rule
 * naming an undeclared verdict, a condition reading a question that isn't
 * there, a missing fallback), not what makes it incomplete (no questions yet,
 * a blank prompt). A draft is saved on every edit, and a schema that refused
 * work-in-progress would make the editor unusable; the editor's Issues panel
 * shows the full list, and the runner throws on the rest.
 */
export const decisionAgentConfigSchema = decisionAgentConfigObjectSchema
  .superRefine((config, ctx) => {
    const verdicts = new Set(config.verdicts)
    const questions = new Map(config.questions.map((q) => [q.id, q]))
    config.rules.forEach((rule, index) => {
      if (config.verdicts.length > 0 && !verdicts.has(rule.verdict)) {
        ctx.addIssue({
          code: 'custom',
          path: ['rules', index, 'verdict'],
          message: `Rule ${index + 1} names the verdict '${rule.verdict}', which is not in the declared set.`,
        })
      }
      rule.conditions.forEach((condition, ci) => {
        if (!questions.has(condition.questionId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['rules', index, 'conditions', ci, 'questionId'],
            message: `Rule ${index + 1} reads a question called '${condition.questionId}', which this agent does not ask.`,
          })
        }
      })
    })
    // A rollup whose last rule can fail to match would make `verdict` nullable,
    // and every consumer — a Switch enumerating cases, an eval expectation, the
    // playground — would need a "no verdict" branch. Requiring the fallback is
    // what keeps the output total.
    const last = config.rules.at(-1)
    if (config.rules.length > 0 && last && last.conditions.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['rules', config.rules.length - 1],
        message:
          'The last rule must be an unconditional fallback, so every state reaches a verdict.',
      })
    }
  })
export type DecisionAgentConfig = z.infer<typeof decisionAgentConfigSchema>

/**
 * A stored agent config, of either kind.
 *
 * The version and draft tables hold ONE opaque JSON column for both, and
 * `wf_agent.kind` is what says which schema parses it. A union rather than a
 * widened single type is what keeps that honest: every read site has to narrow
 * on the kind, and the compiler makes it.
 */
export type AnyAgentConfig = AgentConfig | DecisionAgentConfig

/**
 * A decision agent's input contract: every `${name}` its questions reference,
 * across the prompts AND the considerations.
 *
 * The twin of `agentInputVariables`, and the union for the same reason: the two
 * are interpolated from one bag at run time, so a variable used only inside a
 * consideration is just as much a required input as one in the prompt.
 */
export function decisionAgentInputVariables(
  config: Pick<DecisionAgentConfig, 'questions'>,
): string[] {
  const names = new Set<string>()
  for (const question of config.questions) {
    for (const name of inferPromptVariables(question.prompt)) names.add(name)
    for (const text of Object.values(question.considerations)) {
      for (const name of inferPromptVariables(text)) names.add(name)
    }
  }
  return [...names]
}

/** What a brand-new decision agent starts as: one yes/no question, two verdicts. */
export function starterDecisionAgentConfig(
  modelId: string,
): DecisionAgentConfig {
  return {
    modelId,
    questions: [
      {
        id: 'needs_review',
        type: 'boolean',
        prompt: '',
        considerations: {},
        choices: [],
        threshold: 0.7,
      },
    ],
    verdicts: ['review', 'proceed'],
    rules: [
      {
        id: 'rule_1',
        verdict: 'review',
        conditions: [
          { questionId: 'needs_review', op: 'is', yes: true, keys: [] },
        ],
      },
      { id: 'rule_2', verdict: 'proceed', conditions: [] },
    ],
  }
}
