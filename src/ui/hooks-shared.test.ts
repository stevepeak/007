import { describe, expect, test } from 'bun:test'

import { pendingAiSummaryInterval } from './hooks-shared'

describe('pendingAiSummaryInterval', () => {
  const now = Date.now()

  test('polls while a recent publish still lacks its summary', () => {
    const rows = [
      { aiSummaryShort: 'done', publishedAt: now - 10_000 },
      { aiSummaryShort: null, publishedAt: now - 10_000 },
    ]
    expect(pendingAiSummaryInterval(rows)).toBe(3000)
  })

  test('stops once every row has a summary, or the gap is too old', () => {
    expect(
      pendingAiSummaryInterval([{ aiSummaryShort: 'x', publishedAt: now }]),
    ).toBe(false)
    expect(
      pendingAiSummaryInterval([
        { aiSummaryShort: null, publishedAt: now - 120_000 },
      ]),
    ).toBe(false)
  })

  test('ignores drafts and an unloaded list', () => {
    expect(
      pendingAiSummaryInterval([{ aiSummaryShort: null, publishedAt: null }]),
    ).toBe(false)
    expect(pendingAiSummaryInterval(undefined)).toBe(false)
  })
})
