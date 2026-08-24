import { describe, expect, it } from 'bun:test'

import type { WfEvalResultDTO } from '../../../server/protocol'

import { changedSampleCount, resultDrift, runDrift } from './drift-model'

function result(over: Partial<WfEvalResultDTO> = {}): WfEvalResultDTO {
  return {
    id: crypto.randomUUID(),
    evalRunId: 'run-2',
    rowId: 'row-1',
    wfRunId: 'wf-1',
    runStats: null,
    status: 'pass',
    score: null,
    checkResults: [],
    error: null,
    snapshot: null,
    snapshotHash: 'aaa',
    previousSnapshotHash: 'aaa',
    modelId: null,
    promptLabel: null,
    promptBody: null,
    attempt: null,
    createdAt: 0,
    ...over,
  }
}

describe('resultDrift', () => {
  it('reports an edited sample as changed', () => {
    expect(resultDrift({ snapshotHash: 'bbb', previousSnapshotHash: 'aaa' })).toEqual(
      { changed: true, isNew: false },
    )
  })

  it('reports an untouched sample as unchanged', () => {
    expect(resultDrift({ snapshotHash: 'aaa', previousSnapshotHash: 'aaa' })).toEqual(
      { changed: false, isNew: false },
    )
  })

  // A first appearance has nothing to compare against. Calling that "changed"
  // would flag every sample in a Goal's first run.
  it('reports a sample with no baseline as new, not changed', () => {
    expect(resultDrift({ snapshotHash: 'aaa', previousSnapshotHash: null })).toEqual(
      { changed: false, isNew: true },
    )
  })

  it('stays quiet when neither side has a hash', () => {
    expect(resultDrift({ snapshotHash: null, previousSnapshotHash: null })).toEqual(
      { changed: false, isNew: false },
    )
  })

  // A result predating snapshots can't contradict a baseline it never had.
  it('stays quiet when only the current hash is missing', () => {
    expect(resultDrift({ snapshotHash: null, previousSnapshotHash: 'aaa' })).toEqual(
      { changed: false, isNew: false },
    )
  })
})

describe('runDrift', () => {
  // A model×prompt sweep produces several results per sample, all graded against
  // the same definition — one verdict per sample, not per result.
  it('collapses a sweep to one verdict per sample', () => {
    const drift = runDrift([
      result({ rowId: 'row-1', snapshotHash: 'new', previousSnapshotHash: 'old' }),
      result({ rowId: 'row-1', snapshotHash: 'new', previousSnapshotHash: 'old' }),
      result({ rowId: 'row-2' }),
    ])
    expect(drift.size).toBe(2)
    expect(drift.get('row-1')?.changed).toBe(true)
    expect(drift.get('row-2')?.changed).toBe(false)
  })

  it('is empty for a run with no results', () => {
    expect(runDrift([]).size).toBe(0)
  })
})

describe('changedSampleCount', () => {
  it('counts distinct edited samples, not results', () => {
    expect(
      changedSampleCount([
        result({ rowId: 'a', snapshotHash: 'x', previousSnapshotHash: 'w' }),
        result({ rowId: 'a', snapshotHash: 'x', previousSnapshotHash: 'w' }),
        result({ rowId: 'b', snapshotHash: 'y', previousSnapshotHash: 'v' }),
        result({ rowId: 'c' }),
      ]),
    ).toBe(2)
  })

  it('counts nothing when a run is all first appearances', () => {
    expect(
      changedSampleCount([
        result({ rowId: 'a', previousSnapshotHash: null }),
        result({ rowId: 'b', previousSnapshotHash: null }),
      ]),
    ).toBe(0)
  })
})
