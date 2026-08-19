import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import type { WfSdkConfig } from './config'
import { executeWorkflow, type WorkflowOutputDelivery } from './executor'
import { createMemoryRunRecorder } from './run-recorder'
import type { ToolRegistry } from './tool-registry'

// The walk is rolling, not batched: it re-checks for a reachable Output every
// time ANY node settles, instead of once per fully-settled ready-set.
//
// The difference only shows when a background node is slower than the answer
// arm it was dispatched beside — which is exactly the shape a trigger fan-out
// produces:
//
//   trigger → answer → Output      (what the caller waits for)
//   trigger → slow                 (a side effect nobody waits for)
//
// Under the batched walk the Output was not even OBSERVABLE until `slow`
// finished, because `nextBatch()` was only called again after the whole batch
// settled. `done` fired late by however long the background arm took, which
// defeated the entire point of having a `done` state.
//
// `slow` here never finishes on its own — the test releases it. So these tests
// simply cannot pass on a walk that waits for it.

type Deps = Record<string, never>

/** A promise the test resolves by hand, so "still running" is not a timing bet. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function makeConfig(
  timeline: string[],
  gate: Promise<void>,
): WfSdkConfig<Deps> {
  const registry: ToolRegistry<Deps> = new Map([
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
      'slow',
      {
        id: 'slow',
        name: 'Slow side effect',
        kind: 'function' as const,
        description: 'A background arm that outlives the answer.',
        build: () => async () => {
          timeline.push('slow:start')
          await gate
          timeline.push('slow:end')
          return { ok: true }
        },
      },
    ],
  ])

  return {
    getModel: () => {
      throw new Error('no model needed')
    },
    listModels: () => [],
    listProviders: () => [],
    toolRegistry: registry,
    triggers: { go: { description: 'Go', inputSchema: z.object({}) } },
    buildRunDeps: () => ({}) as Deps,
  }
}

/** trigger fans out to the answer arm and to a background arm, in parallel. */
function fanOutGraph() {
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
      // Declared FIRST so declaration order alone would dispatch the background
      // arm ahead of the answer — the ordering has to come from the answer cone.
      {
        id: 'slow',
        kind: 'tool',
        label: 'Slow',
        position: { x: 200, y: 200 },
        config: { toolId: 'slow', args: {} },
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
    ],
    edges: [
      { id: 'e1', source: 't', target: 'answer', condition: null },
      { id: 'e2', source: 'answer', target: 'o', condition: null },
      { id: 'e3', source: 't', target: 'slow', condition: null },
    ],
  }
}

describe('executor — rolling dispatch', () => {
  test('delivers the answer while a slower background arm is still running', async () => {
    const timeline: string[] = []
    const gate = deferred()
    const deliveries: WorkflowOutputDelivery[] = []

    const run = executeWorkflow({
      graph: fanOutGraph(),
      triggerInput: {},
      config: makeConfig(timeline, gate.promise),
      runContext: { triggerKind: 'go' },
      recorder: createMemoryRunRecorder(),
      onOutput: (d) => {
        deliveries.push(d)
        timeline.push('delivered')
        // Release the background arm only ONCE the answer is already out. If
        // the walk were waiting on it, this would never be reached and the
        // test would hang rather than fail on an assertion.
        gate.release()
      },
    })

    const result = await run

    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].output).toEqual({ text: 'hi' })
    // `done`, not `completed` — and the pending work is a node that is
    // RUNNING, not merely ready, which is what `hasPendingWork` had to learn.
    expect(deliveries[0].pendingWork).toBe(true)
    // Delivered mid-flight: the background arm had started and not finished.
    expect(timeline.indexOf('slow:start')).toBeLessThan(
      timeline.indexOf('delivered'),
    )
    expect(timeline.indexOf('delivered')).toBeLessThan(
      timeline.indexOf('slow:end'),
    )
    // ...and the run still waited for it before resolving `completed`.
    expect(timeline).toContain('slow:end')
    expect(result.drainError).toBeUndefined()
  })

  test('records the background arm as completed, behind the answer', async () => {
    const timeline: string[] = []
    const gate = deferred()
    const recorder = createMemoryRunRecorder()

    await executeWorkflow({
      graph: fanOutGraph(),
      triggerInput: {},
      config: makeConfig(timeline, gate.promise),
      runContext: { triggerKind: 'go' },
      recorder,
      onOutput: () => gate.release(),
    })

    const slow = recorder.steps.find((s) => s.nodeId === 'slow')
    expect(slow?.status).toBe('completed')
    const answer = recorder.steps.find((s) => s.nodeId === 'answer')
    expect(answer?.status).toBe('completed')
    // The answer arm is dispatched first despite being declared second, so its
    // sequence number is the lower one.
    expect(answer?.sequence).toBeLessThan(slow?.sequence ?? Infinity)
  })
})
