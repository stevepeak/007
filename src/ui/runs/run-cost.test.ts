import { describe, expect, test } from 'bun:test'

import type { WfRunSummary } from '../../server/protocol'

import { runCostTitle } from './run-cost'

function runOf(over: Partial<WfRunSummary>): WfRunSummary {
  return { costUsd: 0.02, totalTokens: 1200, tree: null, ...over } as WfRunSummary
}

const tree = {
  costUsd: 4.1,
  totalTokens: 98_000,
  models: [],
  agentMs: null,
  computeMs: 65_000,
  runCount: 12,
  pending: 2,
}

describe('runCostTitle', () => {
  test('a lone run reports only its tokens', () => {
    expect(runCostTitle({ run: runOf({}), where: 'header' })).toBe('1,200 tokens')
  })

  test('a row with listed children says its figure is its own', () => {
    expect(
      runCostTitle({ run: runOf({}), where: 'row', hasChildren: true }),
    ).toBe(
      "1,200 tokens · This run's own cost — its child runs are listed separately, each with theirs.",
    )
  })

  test('a tree total explains itself, worded per surface', () => {
    const run = runOf({ tree })
    const tail =
      '1m 5s of compute, run concurrently · This run itself: $0.020 · 2 still running — this is the total so far'
    expect(runCostTitle({ run, where: 'row', hasChildren: true })).toBe(
      `98,000 tokens · 12 runs in this tree · ${tail}`,
    )
    expect(runCostTitle({ run, where: 'header' })).toBe(
      `98,000 tokens · Across 12 runs, including everything this one spawned · ${tail}`,
    )
  })
})
