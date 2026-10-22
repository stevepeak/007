import { describe, expect, test } from 'bun:test'

import type { ModelOption } from '../engine/model-catalog'

import { defaultJudgeModel } from './judge'

function model(over: Partial<ModelOption> & { id: string }): ModelOption {
  return { label: over.id, capabilities: { structuredOutput: true }, ...over }
}

describe('defaultJudgeModel', () => {
  test('takes the cheapest model that can judge', () => {
    expect(
      defaultJudgeModel([
        model({ id: 'pricey', costPerMTok: 10 }),
        model({ id: 'cheap', costPerMTok: 0.5 }),
        model({ id: 'cheapest-but-no-json', costPerMTok: 0.1, capabilities: { structuredOutput: false } }),
      ])?.id,
    ).toBe('cheap')
  })

  test('falls back to prompt + completion price, and unpriced sorts last', () => {
    expect(
      defaultJudgeModel([
        model({ id: 'unpriced' }),
        model({ id: 'split', promptPricePerMTok: 1, completionPricePerMTok: 2 }),
      ])?.id,
    ).toBe('split')
  })

  test('with no prices at all, keeps catalog order', () => {
    expect(
      defaultJudgeModel([model({ id: 'a' }), model({ id: 'b' })])?.id,
    ).toBe('a')
  })
})
