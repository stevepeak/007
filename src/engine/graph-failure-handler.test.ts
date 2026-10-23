import { describe, expect, test } from 'bun:test'

import type { RunFailure } from './config'
import { executeWorkflow } from './executor'
import { chainGraph, makeConfig } from './executor-test-helpers'
import { RunCancelledError } from './failure-route'
import { workflowGraphSchema } from './graph'
import { failureHandlerGraphOf } from './graph-failure-handler'
import { createMemoryRunRecorder } from './run-recorder'
import { RUN_FAILURE_TRIGGER_KIND } from './trigger-registry'

const at = { x: 0, y: 400 }

// chainGraph (t → boom → after → o) plus a handler:
//   f ─cancelled──→ clean
//   f ─timeout────→ clean
//   f ─rate_limited→ wait → clean2
function withHandler(extra: { nodes?: unknown[]; edges?: unknown[] } = {}) {
  const g = chainGraph({ continueOnError: true })
  return {
    ...g,
    nodes: [
      ...g.nodes,
      { id: 'f', kind: 'on-failure', label: 'On failure', position: at, config: {} },
      {
        id: 'clean',
        kind: 'tool',
        label: 'Clean',
        position: at,
        config: { toolId: 'after', args: {} },
      },
      {
        id: 'wait',
        kind: 'tool',
        label: 'Wait',
        position: at,
        config: { toolId: 'left', args: {} },
      },
      {
        id: 'clean2',
        kind: 'tool',
        label: 'Clean 2',
        position: at,
        config: { toolId: 'right', args: {} },
      },
      ...(extra.nodes ?? []),
    ],
    edges: [
      ...g.edges,
      { id: 'h1', source: 'f', target: 'clean', condition: 'cancelled' },
      { id: 'h2', source: 'f', target: 'clean', condition: 'timeout' },
      { id: 'h3', source: 'f', target: 'wait', condition: 'rate_limited' },
      { id: 'h4', source: 'wait', target: 'clean2', condition: null },
      ...(extra.edges ?? []),
    ],
  }
}

function problems(graph: unknown): string[] {
  const parsed = workflowGraphSchema.safeParse(graph)
  return parsed.success ? [] : parsed.error.issues.map((i) => i.message)
}

describe('on-failure validation', () => {
  test('a detached handler is a valid graph', () => {
    expect(problems(withHandler())).toEqual([])
  })

  test('every edge out of it names a route — there is no catch-all', () => {
    const g = withHandler({
      edges: [{ id: 'x', source: 'f', target: 'clean', condition: null }],
    })
    expect(problems(g).join('\n')).toContain('must name a failure route')
  })

  test('it takes no incoming edges', () => {
    const g = withHandler({
      edges: [{ id: 'x', source: 'after', target: 'f', condition: null }],
    })
    expect(problems(g).join('\n')).toContain('cannot have incoming edges')
  })

  test('a handler node may not also hang off the main graph', () => {
    const g = withHandler({
      edges: [{ id: 'x', source: 'after', target: 'clean', condition: null }],
    })
    expect(problems(g).join('\n')).toContain('the handler must be detached')
  })

  test('refs may not cross between the handler and the main graph', () => {
    const g = withHandler()
    const clean = (g.nodes as { id: string; config: unknown }[]).find(
      (n) => n.id === 'clean',
    )!
    clean.config = {
      toolId: 'after',
      args: { v: { kind: 'ref', nodeId: 'after', path: '' } },
    }
    expect(problems(g).join('\n')).toContain('outside the On Failure handler')
  })

  test('only one per workflow', () => {
    const g = withHandler({
      nodes: [{ id: 'f2', kind: 'on-failure', label: 'Again', position: at, config: {} }],
    })
    expect(problems(g).join('\n')).toContain('at most one On Failure node')
  })
})

describe('the main walk ignores the handler', () => {
  test('a run that succeeds never touches a handler node', async () => {
    const recorder = createMemoryRunRecorder()
    await executeWorkflow({
      graph: withHandler(),
      triggerInput: { n: 1 },
      config: makeConfig(),
      runContext: { triggerKind: 'go' },
      recorder,
    })
    const ran = new Set(recorder.steps.map((s) => s.nodeId))
    for (const id of ['f', 'clean', 'wait', 'clean2']) {
      expect(ran.has(id)).toBe(false)
    }
  })
})

describe('failureHandlerGraphOf', () => {
  test('turns the handler into a run_failure trigger with the same id', () => {
    const g = failureHandlerGraphOf(withHandler(), 'f', 'cancelled')
    const trigger = g.nodes.find((n) => n.id === 'f')
    expect(trigger?.kind).toBe('trigger')
    expect(
      trigger?.kind === 'trigger' ? trigger.config.triggerKind : null,
    ).toBe(RUN_FAILURE_TRIGGER_KIND)
  })

  test('keeps only what the route reaches, with one live edge per fan-in', () => {
    const g = failureHandlerGraphOf(withHandler(), 'f', 'cancelled')
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['clean', 'f'])
    expect(g.edges).toEqual([
      { id: 'h1', source: 'f', target: 'clean', condition: null },
    ])
  })

  test('another route gets its own arm', () => {
    const g = failureHandlerGraphOf(withHandler(), 'f', 'rate_limited')
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['clean2', 'f', 'wait'])
  })

  test('the cut graph runs to completion with no Output', async () => {
    const recorder = createMemoryRunRecorder()
    const result = await executeWorkflow({
      graph: failureHandlerGraphOf(withHandler(), 'f', 'rate_limited'),
      triggerInput: { route: 'rate_limited', error: 'slow down', runId: 'r1', input: {} },
      config: makeConfig(),
      runContext: { triggerKind: RUN_FAILURE_TRIGGER_KIND },
      recorder,
      spawned: true,
    })
    expect(result.outputNodeId).toBeNull()
    const done = recorder.steps
      .filter((s) => s.status === 'completed')
      .map((s) => s.nodeId)
    expect(done).toContain('wait')
    expect(done).toContain('clean2')
  })
})

describe('cancelling the in-process walk', () => {
  test('stops before the next node, past continueOnError, and routes cancelled', async () => {
    let failure: RunFailure | undefined
    let checks = 0
    const recorder = createMemoryRunRecorder()
    await expect(
      executeWorkflow({
        graph: chainGraph({ continueOnError: true }),
        triggerInput: { n: 1 },
        config: makeConfig({
          onRunFailed: (_ctx, f) => {
            failure = f
          },
        }),
        runContext: { triggerKind: 'go' },
        recorder,
        // Let `boom` start, then stop before `after`.
        isCancelled: () => Promise.resolve(checks++ > 0),
      }),
    ).rejects.toBeInstanceOf(RunCancelledError)
    expect(recorder.steps.some((s) => s.nodeId === 'after')).toBe(false)
    expect(failure?.route).toBe('cancelled')
  })
})

