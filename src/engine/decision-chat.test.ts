import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'

import { createChatDecider } from './decision-chat'
import { resolveVerdicts, type DecisionQuestion } from './decision'
import { mockFinish, mockUsage } from './model-test-helpers'

// This file is the proof that `decision.ts` describes a CONTRACT rather than one
// vendor's endpoint: a chat model with no notion of decisions satisfies it. If
// these tests can't be written, the interface isn't generic — it's Venice with
// different field names.

/** A chat model that answers with the weights it is told to. */
function modelReturning(answers: unknown) {
  let prompt = ''
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      prompt = JSON.stringify(options.prompt)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ answers }) }],
        finishReason: mockFinish('stop'),
        usage: mockUsage(120, 30),
        warnings: [],
      }
    },
  })
  return { model, seenPrompt: () => prompt }
}

const QUESTIONS: DecisionQuestion[] = [
  { id: 'urgent', type: 'boolean', prompt: 'Is this urgent?' },
  {
    id: 'team',
    type: 'category',
    prompt: 'Which team?',
    options: [
      { key: 'billing', description: 'Payments' },
      { key: 'technical', description: 'Bugs' },
    ],
  },
  {
    id: 'heat',
    type: 'scale',
    prompt: 'How hot?',
    levels: [{ key: 'calm' }, { key: 'annoyed' }, { key: 'furious' }],
  },
]

describe('createChatDecider', () => {
  test('satisfies the decision contract on a plain chat model', async () => {
    const { model } = modelReturning([
      { id: 'urgent', reasoning: 'three days, no reply', weights: [
        { key: 'yes', weight: 90 },
        { key: 'no', weight: 10 },
      ] },
      { id: 'team', reasoning: 'payouts', weights: [
        { key: 'billing', weight: 80 },
        { key: 'technical', weight: 20 },
      ] },
      { id: 'heat', reasoning: 'fourth contact', weights: [
        { key: 'calm', weight: 0 },
        { key: 'annoyed', weight: 20 },
        { key: 'furious', weight: 80 },
      ] },
    ])

    const decide = createChatDecider({ model, modelId: 'chat:test' })
    const response = await decide({ state: 'payouts failing', questions: QUESTIONS })

    // Answers come back in the contract's shape, so the ENGINE's verdict
    // resolution works unchanged — the same code path a native decider feeds.
    const verdicts = resolveVerdicts(QUESTIONS, response.answers)
    expect(verdicts.urgent).toMatchObject({ value: true })
    expect(verdicts.team).toMatchObject({ value: 'billing' })
    expect(verdicts.heat).toMatchObject({ level: 'furious' })
    expect(response.modelId).toBe('chat:test')
  })

  test('normalizes weights into a distribution rather than trusting them as probabilities', async () => {
    // Models emit weight sets that sum to anything at all. Asking for weights
    // and dividing makes that correct by construction instead of quietly
    // normalizing something that was supposed to already be a distribution.
    const { model } = modelReturning([
      { id: 'urgent', reasoning: 'x', weights: [
        { key: 'yes', weight: 30 },
        { key: 'no', weight: 10 },
      ] },
    ])
    const decide = createChatDecider({ model })
    const response = await decide({
      state: 'x',
      questions: [QUESTIONS[0]],
    })
    expect(response.answers[0]).toMatchObject({
      type: 'boolean',
      probability: 0.75,
    })
  })

  test('reports no confidence of its own, so the engine derives a comparable one', async () => {
    // A chat model's stated confidence is a guess about a guess. Letting it
    // through would make this provider's numbers incomparable with a calibrated
    // one's — and a confidence threshold authored against one would silently
    // mean something else against the other.
    const { model } = modelReturning([
      { id: 'urgent', reasoning: 'x', weights: [
        { key: 'yes', weight: 51 },
        { key: 'no', weight: 49 },
      ] },
    ])
    const decide = createChatDecider({ model })
    const response = await decide({ state: 'x', questions: [QUESTIONS[0]] })

    expect(response.answers[0].confidence).toBeUndefined()
    const verdicts = resolveVerdicts([QUESTIONS[0]], response.answers)
    expect(verdicts.urgent.confidence).toBeCloseTo(0.02)
  })

  test('fills a question the model skipped with maximum uncertainty', async () => {
    // We know what was asked, so "no signal" is better expressed as a uniform
    // distribution (confidence 0, which an escalation floor catches) than as a
    // missing answer that fails the whole node.
    const { model } = modelReturning([
      { id: 'urgent', reasoning: 'x', weights: [{ key: 'yes', weight: 100 }] },
    ])
    const decide = createChatDecider({ model })
    const response = await decide({ state: 'x', questions: QUESTIONS })

    const verdicts = resolveVerdicts(QUESTIONS, response.answers)
    expect(verdicts.team.confidence).toBe(0)
    expect(verdicts.heat.confidence).toBe(0)
  })

  test('shows the model every key, including a boolean yes/no', async () => {
    const { model, seenPrompt } = modelReturning([])
    const decide = createChatDecider({ model })
    await decide({ state: 'the state text', questions: QUESTIONS })

    const prompt = seenPrompt()
    expect(prompt).toContain('the state text')
    expect(prompt).toContain('keys: yes, no')
    // Descriptions ride along so the model can tell the options apart.
    expect(prompt).toContain('billing')
    expect(prompt).toContain('Payments')
    // A scale's order is the scale, so the model is told which way it runs.
    expect(prompt).toContain('ordered lowest to highest')
  })

  test('makes no call for an empty question list', async () => {
    let calls = 0
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls += 1
        return {
          content: [{ type: 'text' as const, text: '{"answers":[]}' }],
          finishReason: mockFinish('stop'),
          usage: mockUsage(1, 1),
          warnings: [],
        }
      },
    })
    const decide = createChatDecider({ model })
    const response = await decide({ state: 'x', questions: [] })
    expect(response.answers).toEqual([])
    expect(calls).toBe(0)
  })
})
