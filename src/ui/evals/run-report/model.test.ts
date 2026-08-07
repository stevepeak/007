import { describe, expect, test } from 'bun:test'

import type { WfEvalResultDTO } from '../../../server/protocol'

import { buildResultRows, sortRows, STATUS_RANK } from './model'

// `model.ts` is deliberately React-free so the report's data logic can be
// pinned here. These tests guard the two things an errored cell depends on: its
// reason surviving into the row, and it sorting where a user will see it.

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
    modelId: null,
    promptLabel: null,
    promptBody: null,
    attempt: null,
    createdAt: 0,
    ...over,
  }
}

describe('buildResultRows', () => {
  test('carries an errored cell’s reason onto the row', () => {
    // Without this the report renders an amber dot and nothing else — the user
    // sees a zero pass rate with no way to tell it was the provider.
    const [row] = buildResultRows(
      [result({ status: 'error', error: 'AI_APICallError: Gateway Timeout (HTTP 504)' })],
      () => undefined,
    )
    expect(row?.status).toBe('error')
    expect(row?.error).toContain('Gateway Timeout')
  })

  test('a graded row has no error', () => {
    const [row] = buildResultRows([result({ status: 'fail' })], () => undefined)
    expect(row?.error).toBeNull()
  })

  test('falls back to the row id when no snapshot was frozen', () => {
    // recordEvalFailure freezes the snapshot precisely so this fallback — a raw
    // UUID where a sample name belongs — stays unreachable for new results.
    const [row] = buildResultRows([result({ rowId: 'abc-123' })], () => undefined)
    expect(row?.sampleName).toBe('abc-123')
  })
})

describe('status ordering', () => {
  test('errors sort above passes, below outright failures', () => {
    expect(STATUS_RANK.fail).toBeLessThan(STATUS_RANK.error as number)
    expect(STATUS_RANK.error).toBeLessThan(STATUS_RANK.pass as number)
  })

  test('sorting by status surfaces problems first', () => {
    const rows = buildResultRows(
      [
        result({ status: 'pass' }),
        result({ status: 'error', error: 'provider down' }),
        result({ status: 'fail' }),
      ],
      () => undefined,
    )
    const sorted = sortRows(rows, { key: 'status', dir: 'asc' })
    expect(sorted.map((r) => r.status)).toEqual(['fail', 'error', 'pass'])
  })
})
