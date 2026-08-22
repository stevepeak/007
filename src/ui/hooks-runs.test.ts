import { describe, expect, test } from 'bun:test'

import type { WfRunDetail, WfRunStepDTO } from '../server/protocol'

import { mergeStepBlock, mergeVersionBlock, settledStepCursor } from './hooks-runs'

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

// A recorded step, reduced to the four fields the merge reasons about.
function step(
  cursor: number,
  sequence: number,
  status: string,
  nodeId = `n${cursor}`,
): WfRunStepDTO {
  return { cursor, sequence, status, nodeId } as unknown as WfRunStepDTO
}

describe('settledStepCursor', () => {
  test('stops at the first step that can still change', () => {
    const steps = [
      step(1, 0, 'completed'),
      step(2, 1, 'skipped'),
      step(3, 2, 'running'),
      // Settled, but ABOVE an unsettled step: watermarking past `running`
      // would stop that step from ever being re-sent.
      step(4, 3, 'completed'),
    ]

    expect(settledStepCursor(steps)).toBe(2)
  })

  test('treats `failed` as unsettled — a resume re-runs it in place', () => {
    expect(settledStepCursor([step(1, 0, 'failed')])).toBeUndefined()
    expect(
      settledStepCursor([step(1, 0, 'completed'), step(2, 1, 'failed')]),
    ).toBe(1)
  })

  test('is undefined when the very first step is still moving', () => {
    expect(settledStepCursor([step(1, 0, 'running')])).toBeUndefined()
    expect(settledStepCursor([])).toBeUndefined()
  })

  test('scans in cursor order regardless of how the list is sorted', () => {
    // Steps arrive sequence-ordered, and an iteration's per-item steps all
    // share a sequence — so list order is NOT cursor order.
    const steps = [
      step(3, 0, 'running'),
      step(1, 0, 'completed'),
      step(2, 0, 'completed'),
    ]

    expect(settledStepCursor(steps)).toBe(2)
  })

  test('advances to the last step once everything has settled', () => {
    expect(
      settledStepCursor([step(1, 0, 'completed'), step(2, 1, 'completed')]),
    ).toBe(2)
  })
})

describe('mergeStepBlock', () => {
  const withSteps = (steps: WfRunStepDTO[], over: Partial<WfRunDetail> = {}) =>
    detail({ steps, ...over })

  test('splices the delta onto the steps already held', () => {
    const prev = withSteps([step(1, 0, 'completed'), step(2, 1, 'running')])
    const next = withSteps([step(2, 1, 'completed'), step(3, 2, 'running')], {
      stepsPartial: true,
    })

    const merged = mergeStepBlock(next, prev)

    expect(merged.steps.map((s) => [s.cursor, s.status])).toEqual([
      [1, 'completed'],
      [2, 'completed'],
      [3, 'running'],
    ])
  })

  test('a re-sent step replaces its earlier state instead of doubling it', () => {
    const prev = withSteps([step(1, 0, 'running')])
    const next = withSteps([step(1, 0, 'completed')], { stepsPartial: true })

    const merged = mergeStepBlock(next, prev)

    // The cursor is stable across `running` → terminal, which is exactly what
    // makes it the merge key: keying on anything that changes would leave the
    // stale copy behind.
    expect(merged.steps).toHaveLength(1)
    expect(merged.steps[0].status).toBe('completed')
  })

  test('orders by sequence first, cursor only to break ties', () => {
    // An iteration's per-item steps all carry sequence 0, so ties are the norm
    // — and consumers have always seen sequence-primary order.
    const prev = withSteps([step(5, 1, 'completed')])
    const next = withSteps([step(2, 0, 'completed'), step(3, 0, 'completed')], {
      stepsPartial: true,
    })

    const merged = mergeStepBlock(next, prev)

    expect(merged.steps.map((s) => s.cursor)).toEqual([2, 3, 5])
  })

  test('keeps the fresh half of the response — this is a splice, not a fallback', () => {
    const prev = withSteps([step(1, 0, 'completed')], {
      run: { ...detail().run, status: 'running' },
    })
    const next = withSteps([step(2, 1, 'completed')], {
      stepsPartial: true,
      run: { ...detail().run, status: 'completed', output: 'answer' },
    })

    const merged = mergeStepBlock(next, prev)

    expect(merged.run.status).toBe('completed')
    expect(merged.run.output).toBe('answer')
  })
})
