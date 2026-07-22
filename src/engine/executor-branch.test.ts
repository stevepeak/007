import { describe, expect, test } from 'bun:test'

import type { RunCompletion } from './config'
import { executeWorkflow } from './executor'
import { createMemoryRunRecorder } from './run-recorder'
import { WorkflowStalledError } from './scheduler'
import { makeConfig } from './executor-test-helpers'

// A branch may connect only one arm; taking the unconnected arm ends that path
// quietly ("fizzles out") — a clean completion with no output, not a stall error.
// Only the `yes` arm is wired: n===999 routes yes (reaches output); anything
// else routes no (fizzles).
function oneArmedBranchGraph() {
  return {
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
        label: 'Is 999?',
        position: { x: 200, y: 0 },
        config: {
          source: { kind: 'ref', nodeId: 't', path: 'n' },
          operator: 'equals',
          value: 999,
        },
      },
      {
        id: 'yes-tool',
        kind: 'tool',
        label: 'After',
        position: { x: 400, y: 0 },
        config: { toolId: 'after', args: {} },
      },
      {
        id: 'yes-out',
        kind: 'output',
        label: 'Out',
        position: { x: 600, y: 0 },
        config: {},
      },
    ],
    edges: [
      { id: 'e0', source: 't', target: 'b', condition: null },
      { id: 'e-yes', source: 'b', target: 'yes-tool', condition: 'yes' },
      { id: 'e-to', source: 'yes-tool', target: 'yes-out', condition: null },
    ],
  }
}

describe('executor — branch with an unconnected arm', () => {
  test('taking the unwired arm fizzles out: completes with no output', async () => {
    const completions: RunCompletion[] = []
    const recorder = createMemoryRunRecorder()
    const result = await executeWorkflow({
      graph: oneArmedBranchGraph(),
      triggerInput: { n: 1 },
      config: makeConfig({ onRunComplete: (_ctx, c) => void completions.push(c) }),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder,
    })
    expect(result.output).toBeUndefined()
    expect(result.outputNodeId).toBeNull()
    // The run still completed — the lifecycle callback fired with the same shape.
    expect(completions).toEqual([{ output: undefined, outputNodeId: null }])
    // The wired arm never ran.
    expect(recorder.steps.some((s) => s.nodeId === 'yes-tool')).toBe(false)
  })

  test('taking the wired arm reaches the Output as usual', async () => {
    const result = await executeWorkflow({
      graph: oneArmedBranchGraph(),
      triggerInput: { n: 999 },
      config: makeConfig(),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder: createMemoryRunRecorder(),
    })
    expect(result.output).toEqual({ ok: true })
    expect(result.outputNodeId).toBe('yes-out')
  })

  test('a stall with no decision fired is still a hard error', async () => {
    // `dangling` has no incoming edge, so `join` never becomes ready and the
    // Output is unreachable — with no decision node, this is a malformed graph.
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
          id: 'a',
          kind: 'tool',
          label: 'A',
          position: { x: 200, y: 0 },
          config: { toolId: 'after', args: {} },
        },
        {
          id: 'dangling',
          kind: 'tool',
          label: 'Dangling',
          position: { x: 200, y: 100 },
          config: { toolId: 'after', args: {} },
        },
        {
          id: 'j',
          kind: 'tool',
          label: 'Join',
          position: { x: 400, y: 0 },
          config: { toolId: 'after', args: {} },
        },
        {
          id: 'o',
          kind: 'output',
          label: 'Out',
          position: { x: 600, y: 0 },
          config: {},
        },
      ],
      edges: [
        { id: 'e0', source: 't', target: 'a', condition: null },
        { id: 'e1', source: 'a', target: 'j', condition: null },
        { id: 'e2', source: 'dangling', target: 'j', condition: null },
        { id: 'e3', source: 'j', target: 'o', condition: null },
      ],
    }
    await expect(
      executeWorkflow({
        graph,
        triggerInput: { n: 1 },
        config: makeConfig(),
        runContext: { subjectId: 'acme', triggerKind: 'go' },
        recorder: createMemoryRunRecorder(),
      }),
    ).rejects.toBeInstanceOf(WorkflowStalledError)
  })
})
