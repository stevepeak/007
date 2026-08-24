import { describe, expect, test } from 'bun:test'

import type { WfEvalResultDTO } from '../../../server/protocol'

import { buildMatrixSummary, isMatrixRun } from './matrix-model'
import { cellKey } from './model'

// The matrix roll-up decides which model/prompt combination a user is told to
// adopt, so its two judgement calls are worth pinning: a losing run must not be
// able to win on cost or speed it never earned, and pass rate must outrank
// score rather than being blended with it.

function result(over: Partial<WfEvalResultDTO> = {}): WfEvalResultDTO {
  return {
    id: crypto.randomUUID(),
    evalRunId: 'run-1',
    rowId: 'row-1',
    wfRunId: 'wf-1',
    runStats: null,
    status: 'pass',
    score: null,
    checkResults: [],
    error: null,
    snapshot: null,
    snapshotHash: null,
    previousSnapshotHash: null,
    modelId: null,
    promptLabel: null,
    promptBody: null,
    attempt: null,
    createdAt: 0,
    ...over,
  }
}

function stats(costUsd: number, totalTokens: number, durationMs: number) {
  return { costUsd, totalTokens, durationMs, models: [], agentVersion: null }
}

describe('isMatrixRun', () => {
  test('a plain run varies neither axis', () => {
    expect(isMatrixRun([result(), result()])).toBe(false)
  })

  test('varying either axis alone is still a matrix', () => {
    expect(isMatrixRun([result({ modelId: 'm1' })])).toBe(true)
    expect(isMatrixRun([result({ promptLabel: 'Test prompt 1' })])).toBe(true)
  })
})

describe('buildMatrixSummary', () => {
  test('a failed run cannot win Cheapest or Fastest on cost it never earned', () => {
    // The whole trap: a model that fails instantly looks free and fast. Only
    // passing runs may contribute cost/throughput.
    const matrix = buildMatrixSummary([
      result({
        modelId: 'cheap-but-wrong',
        status: 'fail',
        runStats: stats(0.0001, 10, 100),
      }),
      result({
        modelId: 'right',
        status: 'pass',
        runStats: stats(0.5, 1000, 2000),
      }),
    ])
    expect(matrix.cheapest).toBe(cellKey('right', null))
    expect(matrix.fastest).toBe(cellKey('right', null))
    // The failing cell still appears in the grid — it just wins nothing.
    expect(matrix.cells).toHaveLength(2)
    const failing = matrix.byKey.get(cellKey('cheap-but-wrong', null))
    expect(failing?.avgCostUsd).toBeNull()
    expect(failing?.tokensPerSec).toBeNull()
  })

  test('pass rate outranks mean score, which only breaks ties', () => {
    // A cell that passes more often wins even when the other scores higher on
    // the tests it did pass.
    const matrix = buildMatrixSummary([
      result({ modelId: 'reliable', status: 'pass', score: 60 }),
      result({ modelId: 'reliable', status: 'pass', score: 60 }),
      result({ modelId: 'brilliant', status: 'pass', score: 100 }),
      result({ modelId: 'brilliant', status: 'fail', score: 100 }),
    ])
    expect(matrix.bestAcc).toBe(cellKey('reliable', null))
  })

  test('ties on pass rate fall through to score', () => {
    const matrix = buildMatrixSummary([
      result({ modelId: 'lower', status: 'pass', score: 70 }),
      result({ modelId: 'higher', status: 'pass', score: 90 }),
    ])
    expect(matrix.bestAcc).toBe(cellKey('higher', null))
  })

  test('throughput is measured, not advertised — tokens ÷ wall-clock', () => {
    const matrix = buildMatrixSummary([
      result({ modelId: 'm1', status: 'pass', runStats: stats(1, 3000, 2000) }),
    ])
    expect(matrix.byKey.get(cellKey('m1', null))?.tokensPerSec).toBe(1500)
  })

  test('a cell with no comparable data wins nothing rather than winning by default', () => {
    const matrix = buildMatrixSummary([
      result({ modelId: 'm1', status: 'pass', runStats: null }),
    ])
    expect(matrix.cheapest).toBeNull()
    expect(matrix.fastest).toBeNull()
    // Accuracy is still comparable — it needs no runStats.
    expect(matrix.bestAcc).toBe(cellKey('m1', null))
  })

  test('axes keep first-seen order and collapse when only one varies', () => {
    const matrix = buildMatrixSummary([
      result({ modelId: 'b', promptLabel: null }),
      result({ modelId: 'a', promptLabel: null }),
    ])
    expect(matrix.modelAxis).toEqual(['b', 'a'])
    expect(matrix.promptAxis).toEqual([null])
  })
})
