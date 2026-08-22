import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import type { WfSdkConfig } from './config'
import { executeWorkflow, type WorkflowOutputDelivery } from './executor'
import { createMemoryRunRecorder } from './run-recorder'
import type { ToolRegistry } from './tool-registry'

// Reaching an Output makes a run `done`, not `completed`: arms of the graph
// that don't feed the Output must still run themselves out. The regression
// these tests pin is a real one — a chat graph shaped
//
//   trigger → agent → Output
//   trigger → branch --yes--> update_chat
//
// where the answer arm won the race to the Output and the backend returned on
// it, so `update_chat` was left ready-but-never-dispatched and silently dropped.

type Deps = { subject: string }

/** The tool registry, plus the log of what ran, in the order it ran. */
function makeRegistry(timeline: string[]): ToolRegistry<Deps> {
  return new Map([
    [
      'answer',
      {
        id: 'answer',
        name: 'Answer',
        kind: 'function' as const,
        description: 'Produces the run’s answer.',
        build: () => () => {
          timeline.push('answer')
          return Promise.resolve({ text: 'hi' })
        },
      },
    ],
    [
      'side',
      {
        id: 'side',
        name: 'Side effect',
        kind: 'function' as const,
        description: 'A fire-and-forget arm the Output never depends on.',
        build: () => () => {
          timeline.push('side')
          return Promise.resolve({ ok: true })
        },
      },
    ],
    [
      'side-boom',
      {
        id: 'side-boom',
        name: 'Failing side effect',
        kind: 'function' as const,
        description: 'A background arm that breaks.',
         
        build: () => async () => {
          timeline.push('side-boom')
          throw new Error('side arm failed')
        },
      },
    ],
  ])
}

function makeConfig(timeline: string[]): WfSdkConfig<Deps> {
  return {
    getModel: () => {
      throw new Error('no model needed')
    },
    listModels: () => [],
    listProviders: () => [],
    toolRegistry: makeRegistry(timeline),
    triggers: {
      go: { description: 'Go', inputSchema: z.object({ n: z.number() }) },
    },
    buildRunDeps: (ctx) => ({ subject: ctx.subjectId ?? '' }),
  }
}

/**
 * trigger → answer → Output   (the arm the caller waits on)
 * trigger → branch --yes--> <sideToolId>   (the arm nothing waits on)
 *
 * With `n: 999` the branch routes `yes`, so the side arm is ready at the same
 * moment the Output becomes reachable — the exact race that used to drop it.
 * Pass `sideToolId: null` for a graph with no background arm at all.
 */
function graph(sideToolId: string | null) {
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
        id: 'answer',
        kind: 'tool',
        label: 'Answer',
        position: { x: 200, y: 0 },
        config: { toolId: 'answer', args: {} },
      },
      {
        id: 'o',
        kind: 'output',
        label: 'Out',
        position: { x: 400, y: 0 },
        config: { source: { kind: 'ref', nodeId: 'answer', path: '' } },
      },
      ...(sideToolId
        ? [
            {
              id: 'b',
              kind: 'branch',
              label: 'Is 999?',
              position: { x: 200, y: 200 },
              config: {
                source: { kind: 'ref', nodeId: 't', path: 'n' },
                operator: 'equals',
                value: 999,
              },
            },
            {
              id: 'side',
              kind: 'tool',
              label: 'Side',
              position: { x: 400, y: 200 },
              config: { toolId: sideToolId, args: {} },
            },
          ]
        : []),
    ],
    edges: [
      { id: 'e1', source: 't', target: 'answer', condition: null },
      { id: 'e2', source: 'answer', target: 'o', condition: null },
      ...(sideToolId
        ? [
            { id: 'e3', source: 't', target: 'b', condition: null },
            { id: 'e4', source: 'b', target: 'side', condition: 'yes' },
          ]
        : []),
    ],
  }
}

describe('executor — draining branches the Output does not feed', () => {
  test('a side arm still runs after the Output is reached', async () => {
    const timeline: string[] = []
    const recorder = createMemoryRunRecorder()
    const result = await executeWorkflow({
      graph: graph('side'),
      triggerInput: { n: 999 },
      config: makeConfig(timeline),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder,
    })

    expect(result.output).toEqual({ text: 'hi' })
    expect(result.outputNodeId).toBe('o')
    expect(result.drainError).toBeUndefined()
    // The whole point: the tool on the branch arm executed, and its step is in
    // the trace rather than missing from it.
    expect(timeline).toContain('side')
    const side = recorder.steps.find((s) => s.nodeId === 'side')
    expect(side?.status).toBe('completed')
  })

  test('the answer is delivered BEFORE the side arm runs', async () => {
    const timeline: string[] = []
    const deliveries: WorkflowOutputDelivery[] = []
    await executeWorkflow({
      graph: graph('side'),
      triggerInput: { n: 999 },
      config: makeConfig(timeline),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder: createMemoryRunRecorder(),
      onOutput: (d) => {
        deliveries.push(d)
        timeline.push('delivered')
      },
    })

    // The answer's own node runs, then the reader is released. Both arms still
    // run exactly once.
    expect(timeline.indexOf('answer')).toBeLessThan(
      timeline.indexOf('delivered'),
    )
    expect(timeline.filter((t) => t === 'side')).toHaveLength(1)
    // Where 'side' lands relative to 'delivered' is deliberately NOT asserted.
    // Under the old batched walk the side arm could not start until the whole
    // ready-set had settled, which forced it after the delivery; the rolling
    // walk starts it the moment its branch routes, so the two are concurrent
    // and their start order is a genuine race. That is the improvement, not a
    // regression — what matters is that the delivery does not WAIT on the side
    // arm, which `executor-rolling.test.ts` pins with a side arm that cannot
    // finish until the test lets it.
    expect(deliveries).toHaveLength(1)
    // `done`, not `completed`: there was still an arm to drain.
    expect(deliveries[0].pendingWork).toBe(true)
    expect(deliveries[0].output).toEqual({ text: 'hi' })
  })

  test('a graph with nothing left to drain reports no pending work', async () => {
    const timeline: string[] = []
    const deliveries: WorkflowOutputDelivery[] = []
    await executeWorkflow({
      graph: graph(null),
      triggerInput: { n: 999 },
      config: makeConfig(timeline),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder: createMemoryRunRecorder(),
      onOutput: (d) => void deliveries.push(d),
    })

    // Lets the backend settle straight to `completed` in one write, so an
    // ordinary run never passes through `done`.
    expect(deliveries[0].pendingWork).toBe(false)
  })

  test('the unwired arm is left alone — draining is not "run everything"', async () => {
    const timeline: string[] = []
    const recorder = createMemoryRunRecorder()
    // n: 1 routes the branch to `no`, which has no outgoing edge.
    const result = await executeWorkflow({
      graph: graph('side'),
      triggerInput: { n: 1 },
      config: makeConfig(timeline),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder,
    })

    expect(result.output).toEqual({ text: 'hi' })
    expect(timeline).not.toContain('side')
    expect(recorder.steps.some((s) => s.nodeId === 'side')).toBe(false)
  })

  test('a background arm that fails does not retract the answer', async () => {
    const timeline: string[] = []
    const failures: string[] = []
    const recorder = createMemoryRunRecorder()
    const config: WfSdkConfig<Deps> = {
      ...makeConfig(timeline),
      onRunFailed: (_ctx, f) => void failures.push(f.error),
    }
    const result = await executeWorkflow({
      graph: graph('side-boom'),
      triggerInput: { n: 999 },
      config,
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder,
    })

    // The answer stands — the host was handed it before this node ever ran, and
    // it cannot be un-handed.
    expect(result.output).toEqual({ text: 'hi' })
    expect(result.drainError).toContain('side arm failed')
    // ...and the run is NOT reported as failed.
    expect(failures).toEqual([])
    expect(recorder.steps.find((s) => s.nodeId === 'side')?.status).toBe(
      'failed',
    )
  })
})
