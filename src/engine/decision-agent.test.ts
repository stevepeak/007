import { describe, expect, test } from 'bun:test'

import type { Decider, DecisionAnswer, DecisionVerdict } from './decision'
import {
  applyDecisionRules,
  decisionAgentQuestions,
  runDecisionAgent,
} from './decision-agent'
import {
  decisionAgentConfigIssues,
  decisionAgentConfigSchema,
  starterDecisionAgentConfig,
  type DecisionAgentConfig,
  type DecisionAgentQuestion,
} from './decision-agent-schema'

// The three things a decision agent is, tested apart: the questions it sends,
// the rollup it applies, and the one call in between.

function question(
  over: Partial<DecisionAgentQuestion> = {},
): DecisionAgentQuestion {
  return {
    id: 'is_urgent',
    type: 'boolean',
    prompt: 'Does this need a person to look at it before we act?',
    considerations: {},
    choices: [],
    ...over,
  }
}

function config(over: Partial<DecisionAgentConfig> = {}): DecisionAgentConfig {
  return decisionAgentConfigSchema.parse({
    modelId: 'venice:jev-latest',
    questions: [question({ threshold: 0.7 })],
    verdicts: ['escalate', 'auto_reply'],
    rules: [
      {
        id: 'r1',
        verdict: 'escalate',
        conditions: [{ questionId: 'is_urgent', op: 'is', yes: true }],
      },
      { id: 'r2', verdict: 'auto_reply', conditions: [] },
    ],
    ...over,
  })
}

/** A decider that answers exactly what it is handed, in order. */
function stubDecider(answers: DecisionAnswer[], modelId = 'venice:jev-1'): Decider {
  return async () => ({ modelId, answers, usage: { inputTokens: 10 } })
}

describe('decisionAgentQuestions', () => {
  test('sends considerations as the provider contract names them', () => {
    const [q] = decisionAgentQuestions(
      config({
        questions: [
          question({
            considerations: { overdue: 'No reply in 48h', threat: 'Mentions a regulator' },
          }),
        ],
      }),
    )
    expect(q.type).toBe('boolean')
    expect(q.type === 'boolean' ? q.considerations : null).toEqual({
      overdue: 'No reply in 48h',
      threat: 'Mentions a regulator',
    })
  })

  test('omits considerations entirely when none are authored', () => {
    // `criteria: {}` is a different request from no criteria at all, and an
    // author who wrote none meant the latter.
    const [q] = decisionAgentQuestions(config())
    expect(q.type === 'boolean' && 'considerations' in q).toBe(false)
  })

  test("a choice's label reaches the provider when no description is written", () => {
    // The Jev adapter sends `description ?? key`, so a label-only question
    // would otherwise describe its options to the model as `needs_review`.
    const [q] = decisionAgentQuestions(
      config({
        questions: [
          question({
            type: 'category',
            choices: [
              { key: 'billing', label: 'A billing dispute' },
              { key: 'outage', label: 'Service outage' },
            ],
          }),
        ],
      }),
    )
    expect(q.type === 'category' ? q.options : []).toEqual([
      { key: 'billing', description: 'A billing dispute' },
      { key: 'outage', description: 'Service outage' },
    ])
  })

  test('interpolates ${vars} into prompts and considerations', () => {
    const [q] = decisionAgentQuestions(
      config({
        questions: [
          question({
            prompt: 'Is this urgent for ${client}?',
            considerations: { sla: '${client} is on a 24h SLA' },
          }),
        ],
      }),
      { client: 'Acme' },
    )
    expect(q.prompt).toBe('Is this urgent for Acme?')
    expect(q.type === 'boolean' ? q.considerations?.sla : null).toBe(
      'Acme is on a 24h SLA',
    )
  })
})

describe('applyDecisionRules', () => {
  const booleanVerdict = (probability: number): DecisionVerdict => ({
    id: 'is_urgent',
    type: 'boolean',
    value: probability >= 0.7,
    probability,
    threshold: 0.7,
    confidence: 0.5,
    distribution: [
      { key: 'yes', probability },
      { key: 'no', probability: 1 - probability },
    ],
  })

  test('the first matching rule wins and says which it was', () => {
    const cfg = config()
    const rollup = applyDecisionRules(
      cfg.rules,
      { is_urgent: booleanVerdict(0.82) },
      cfg.questions,
    )
    expect(rollup.verdict).toBe('escalate')
    expect(rollup.because).toBe('rule 1 (is_urgent 0.82)')
  })

  test('the fallback names itself rather than reporting no conditions', () => {
    const cfg = config()
    const rollup = applyDecisionRules(
      cfg.rules,
      { is_urgent: booleanVerdict(0.2) },
      cfg.questions,
    )
    expect(rollup.verdict).toBe('auto_reply')
    expect(rollup.because).toContain('fallback')
  })

  test('`is` reads the QUESTION’s threshold, `gte` its own cut', () => {
    // 0.75 is yes at the question's 0.7 and below a rule's own 0.9.
    const cfg = config({
      rules: [
        {
          id: 'r1',
          verdict: 'escalate',
          conditions: [{ questionId: 'is_urgent', op: 'gte', probability: 0.9, keys: [] }],
        },
        { id: 'r2', verdict: 'auto_reply', conditions: [] },
      ],
    })
    expect(
      applyDecisionRules(cfg.rules, { is_urgent: booleanVerdict(0.75) }, cfg.questions)
        .verdict,
    ).toBe('auto_reply')
  })

  test('a scale compares through the DECLARED level order, not the label', () => {
    const cfg = config({
      questions: [
        question({
          id: 'sensitivity',
          type: 'scale',
          choices: [
            { key: 'routine', label: 'Routine' },
            // Two levels sharing a description is exactly the case that makes
            // comparing by the provider's legend wrong.
            { key: 'sensitive', label: 'Handle with care' },
            { key: 'urgent', label: 'Handle with care' },
          ],
        }),
      ],
      rules: [
        {
          id: 'r1',
          verdict: 'escalate',
          conditions: [
            { questionId: 'sensitivity', op: 'atLeast', keys: ['sensitive'] },
          ],
        },
        { id: 'r2', verdict: 'auto_reply', conditions: [] },
      ],
    })
    const scaleVerdict = (level: string): DecisionVerdict => ({
      id: 'sensitivity',
      type: 'scale',
      value: 1.2,
      level,
      confidence: 0.4,
      distribution: [],
    })
    expect(
      applyDecisionRules(cfg.rules, { sensitivity: scaleVerdict('urgent') }, cfg.questions)
        .verdict,
    ).toBe('escalate')
    expect(
      applyDecisionRules(cfg.rules, { sensitivity: scaleVerdict('routine') }, cfg.questions)
        .verdict,
    ).toBe('auto_reply')
  })

  test('every condition must hold — AND, not OR', () => {
    const cfg = config({
      questions: [
        question({ threshold: 0.7 }),
        question({
          id: 'matter',
          type: 'category',
          choices: [{ key: 'billing' }, { key: 'outage' }],
        }),
      ],
      rules: [
        {
          id: 'r1',
          verdict: 'escalate',
          conditions: [
            { questionId: 'is_urgent', op: 'is', yes: true, keys: [] },
            { questionId: 'matter', op: 'equals', keys: ['outage'] },
          ],
        },
        { id: 'r2', verdict: 'auto_reply', conditions: [] },
      ],
    })
    const matter = (value: string): DecisionVerdict => ({
      id: 'matter',
      type: 'category',
      value,
      confidence: 0.6,
      distribution: [],
    })
    expect(
      applyDecisionRules(
        cfg.rules,
        { is_urgent: booleanVerdict(0.9), matter: matter('billing') },
        cfg.questions,
      ).verdict,
    ).toBe('auto_reply')
    expect(
      applyDecisionRules(
        cfg.rules,
        { is_urgent: booleanVerdict(0.9), matter: matter('outage') },
        cfg.questions,
      ).verdict,
    ).toBe('escalate')
  })

  test('no matching rule and no fallback throws rather than returning null', () => {
    // Every consumer downstream is written against a total value, so this is
    // loud rather than a verdict of `undefined`.
    expect(() =>
      applyDecisionRules(
        [
          {
            id: 'r1',
            verdict: 'escalate',
            conditions: [{ questionId: 'is_urgent', op: 'is', yes: true, keys: [] }],
          },
        ],
        { is_urgent: booleanVerdict(0.1) },
        [question({ threshold: 0.7 })],
      ),
    ).toThrow(/fallback/)
  })
})

describe('runDecisionAgent', () => {
  test('returns the verdict, the trace and the ECHOED model id', async () => {
    const result = await runDecisionAgent({
      config: config(),
      state: 'Customer is furious about a duplicate charge.',
      getDecider: () =>
        stubDecider([{ id: 'is_urgent', type: 'boolean', probability: 0.9 }]),
    })
    expect(result.verdict).toBe('escalate')
    expect(result.answers.is_urgent.type).toBe('boolean')
    // `jev-latest` floats, so the record has to carry what ANSWERED, not what
    // was asked for — the third eval-drift axis.
    expect(result.modelId).toBe('venice:jev-1')
  })

  test("applies each question's own threshold, not one shared cut", async () => {
    const result = await runDecisionAgent({
      config: config({
        questions: [
          question({ id: 'lenient', threshold: 0.2 }),
          question({ id: 'strict', threshold: 0.95 }),
        ],
        rules: [{ id: 'r1', verdict: 'auto_reply', conditions: [] }],
        verdicts: ['auto_reply'],
      }),
      state: 'x',
      getDecider: () =>
        stubDecider([
          { id: 'lenient', type: 'boolean', probability: 0.5 },
          { id: 'strict', type: 'boolean', probability: 0.5 },
        ]),
    })
    const lenient = result.answers.lenient
    const strict = result.answers.strict
    expect(lenient.type === 'boolean' && lenient.value).toBe(true)
    expect(strict.type === 'boolean' && strict.value).toBe(false)
  })

  test('refuses to run with no questions rather than calling the provider', async () => {
    let called = false
    await expect(
      runDecisionAgent({
        config: config({ questions: [], rules: [{ id: 'r1', verdict: 'auto_reply', conditions: [] }] }),
        state: 'x',
        getDecider: () => {
          called = true
          return stubDecider([])
        },
      }),
    ).rejects.toThrow(/asks no questions/)
    expect(called).toBe(false)
  })
})

describe('decisionAgentConfigIssues', () => {
  test('a starter config is complete except for the prompt nobody else can write', () => {
    expect(decisionAgentConfigIssues(starterDecisionAgentConfig('venice:jev'))).toEqual([
      "Question 'needs_review' has no prompt.",
    ])
  })

  test('names a rule that reads a question the agent does not ask', () => {
    const issues = decisionAgentConfigIssues({
      modelId: 'm',
      questions: [question({ prompt: 'ok' })],
      verdicts: ['escalate'],
      rules: [
        {
          id: 'r1',
          verdict: 'escalate',
          conditions: [{ questionId: 'typo', op: 'is', yes: true, keys: [] }],
        },
        { id: 'r2', verdict: 'escalate', conditions: [] },
      ],
    })
    expect(issues.join(' ')).toContain("'typo'")
  })

  test('names a rule whose verdict is not declared', () => {
    const issues = decisionAgentConfigIssues({
      modelId: 'm',
      questions: [question({ prompt: 'ok' })],
      verdicts: ['escalate'],
      rules: [{ id: 'r1', verdict: 'nope', conditions: [] }],
    })
    expect(issues.join(' ')).toContain("'nope'")
  })

  test('a rule above the fallback that always matches is reported as unreachable', () => {
    const issues = decisionAgentConfigIssues({
      modelId: 'm',
      questions: [question({ prompt: 'ok' })],
      verdicts: ['a', 'b'],
      rules: [
        { id: 'r1', verdict: 'a', conditions: [] },
        { id: 'r2', verdict: 'b', conditions: [] },
      ],
    })
    expect(issues.join(' ')).toContain('unreachable')
  })

  test('an op the question type does not support is named, not silently false', () => {
    const issues = decisionAgentConfigIssues({
      modelId: 'm',
      questions: [
        question({
          id: 'matter',
          type: 'category',
          prompt: 'What kind?',
          choices: [{ key: 'a' }, { key: 'b' }],
        }),
      ],
      verdicts: ['x'],
      rules: [
        {
          id: 'r1',
          verdict: 'x',
          conditions: [{ questionId: 'matter', op: 'gte', probability: 0.5, keys: [] }],
        },
        { id: 'r2', verdict: 'x', conditions: [] },
      ],
    })
    expect(issues.join(' ')).toContain('does not support')
  })
})

describe('decisionAgentConfigSchema', () => {
  test('accepts an incomplete draft — the editor saves on every keystroke', () => {
    // Narrower than `decisionAgentConfigIssues` on purpose: a half-written
    // matrix must still persist as a draft.
    const parsed = decisionAgentConfigSchema.parse({
      modelId: 'm',
      questions: [],
      verdicts: [],
      rules: [],
    })
    expect(parsed.questions).toEqual([])
  })

  test('rejects a rollup whose last rule can fail to match', () => {
    expect(() =>
      decisionAgentConfigSchema.parse({
        modelId: 'm',
        questions: [question({ prompt: 'ok' })],
        verdicts: ['escalate'],
        rules: [
          {
            id: 'r1',
            verdict: 'escalate',
            conditions: [{ questionId: 'is_urgent', op: 'is', yes: true }],
          },
        ],
      }),
    ).toThrow(/fallback/)
  })
})
