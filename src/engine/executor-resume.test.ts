import { describe, expect, test } from 'bun:test'

import { executeWorkflow } from './executor'
import { chainGraph, makeConfig } from './executor-test-helpers'
import { createMemoryRunRecorder } from './run-recorder'

// Resuming an interrupted run in place. The steps a dead attempt completed are
// handed in as `resumeSteps`; the walk must treat them as done — never
// re-executing them, never re-recording them — and pick up at the first node
// that has no completed step. `chainGraph` is trigger → boom → after → output,
// and `boom` ALWAYS throws, so the only way this run reaches its Output is by
// the seed being honoured.

describe('executor — resumeSteps', () => {
  test('seeded steps are skipped and the walk resumes after them', async () => {
    const recorder = createMemoryRunRecorder()
    const result = await executeWorkflow({
      graph: chainGraph(),
      triggerInput: { n: 1 },
      config: makeConfig(),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder,
      resumeSteps: [
        {
          nodeId: 'boom',
          nodeKind: 'tool',
          sequence: 1,
          input: { n: 1 },
          output: { fromBefore: true },
        },
      ],
    })
    expect(result.output).toEqual({ ok: true })
    // `boom` was not re-recorded: the rows of a resumed run already exist.
    expect(recorder.steps.map((s) => s.nodeId)).toEqual(['t', 'after', 'o'])
    // Numbering continues past the seeded step rather than colliding with it.
    const after = recorder.steps.find((s) => s.nodeId === 'after')
    expect(after?.sequence).toBe(2)
  })

  test('a seeded decision node routes the way it originally decided', async () => {
    // trigger → branch(yes/no) → left | right → output(left)
    const graph = {
      version: 1 as const,
      nodes: [
        {
          id: 't',
          kind: 'trigger',
          label: 'Go',
          position: { x: 0, y: 0 },
          config: { triggerKind: 'go' },
        },
        {
          id: 'b',
          kind: 'branch',
          label: 'Pick',
          position: { x: 200, y: 0 },
          config: {
            mode: 'rule',
            rule: {
              source: { kind: 'ref', nodeId: 't', path: 'n' },
              operator: 'equals',
              value: '1',
            },
          },
        },
        {
          id: 'left',
          kind: 'tool',
          label: 'Left',
          position: { x: 400, y: -100 },
          config: { toolId: 'left', args: {} },
        },
        {
          id: 'right',
          kind: 'tool',
          label: 'Right',
          position: { x: 400, y: 100 },
          config: { toolId: 'right', args: {} },
        },
        {
          id: 'o',
          kind: 'output',
          label: 'Out',
          position: { x: 600, y: 0 },
          config: { source: { kind: 'ref', nodeId: 'right', path: '' } },
        },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'b', condition: null },
        { id: 'e2', source: 'b', target: 'left', condition: 'yes' },
        { id: 'e3', source: 'b', target: 'right', condition: 'no' },
        { id: 'e4', source: 'left', target: 'o', condition: null },
        { id: 'e5', source: 'right', target: 'o', condition: null },
      ],
    }
    const recorder = createMemoryRunRecorder()
    // The live rule would say "yes" (n = 1); the seeded decision said "no".
    // A resume must replay the RECORDED decision — the rest of the run already
    // happened on that basis — so `right` runs, not `left`.
    const result = await executeWorkflow({
      graph,
      triggerInput: { n: 1 },
      config: makeConfig(),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder,
      resumeSteps: [
        {
          nodeId: 'b',
          nodeKind: 'branch',
          sequence: 1,
          input: { n: 1 },
          output: { result: 'no', reasoning: 'recorded earlier' },
          branchResult: { result: 'no', reasoning: 'recorded earlier' },
        },
      ],
    })
    expect(result.output).toEqual({ v: 'R' })
    expect(recorder.steps.map((s) => s.nodeId)).toEqual(['t', 'right', 'o'])
  })
})
