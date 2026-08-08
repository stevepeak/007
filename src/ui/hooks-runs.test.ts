import { describe, expect, test } from 'bun:test'

import type { WfRunDetail } from '../server/protocol'
import { mergeVersionBlock } from './hooks-runs'

// The five fields `getRun` derives from the workflow version row. If the server
// ever derives a sixth and this list doesn't grow, that field arrives as its
// placeholder on every poll after the first — silently, since the shape still
// typechecks. These tests are the tripwire.
function detail(over: Partial<WfRunDetail> = {}): WfRunDetail {
  return {
    run: {
      id: 'run_1',
      status: 'running',
      triggerKind: 'chat',
      workflowId: 'wf_1',
      workflowName: 'Intake',
      versionNumber: 4,
      subjectId: null,
      correlationId: null,
      createdAt: 0,
      startedAt: null,
      finishedAt: null,
      error: null,
      totalTokens: null,
      costUsd: null,
      sentryTraceId: null,
      sentryTraceUrl: null,
      output: null,
    },
    steps: [],
    logs: [],
    graph: { nodes: [], edges: [] } as unknown as WfRunDetail['graph'],
    versionNumber: 4,
    workflowVersionId: 'wv_1',
    ...over,
  }
}

describe('mergeVersionBlock', () => {
  test('restores every version-derived field from the cached response', () => {
    const prev = detail()
    // What the server sends when it skipped the version lookup: placeholders in
    // exactly the five slots, real data everywhere else.
    const next = detail({
      graph: null,
      versionNumber: null,
      versionOmitted: true,
      run: { ...detail().run, workflowId: '', workflowName: '(unknown workflow)', versionNumber: 0 },
      logs: [
        { nodeId: 'n1', nodeKind: 'agent', sequence: 1, level: 'info', message: 'hi', meta: null, ts: 5 },
      ],
    })

    const merged = mergeVersionBlock(next, prev)

    expect(merged.graph).toBe(prev.graph)
    expect(merged.versionNumber).toBe(4)
    expect(merged.run.workflowId).toBe('wf_1')
    expect(merged.run.workflowName).toBe('Intake')
    expect(merged.run.versionNumber).toBe(4)
    // No placeholder survives the merge.
    expect(JSON.stringify(merged)).not.toContain('(unknown workflow)')
  })

  test('keeps the fresh half — this is a splice, not a fallback to the old response', () => {
    const prev = detail({ run: { ...detail().run, status: 'running' } })
    const next = detail({
      graph: null,
      versionOmitted: true,
      run: { ...detail().run, status: 'completed', output: 'answer' },
      steps: [{ nodeId: 'n1' }] as unknown as WfRunDetail['steps'],
    })

    const merged = mergeVersionBlock(next, prev)

    expect(merged.run.status).toBe('completed')
    expect(merged.run.output).toBe('answer')
    expect(merged.steps).toHaveLength(1)
  })
})
