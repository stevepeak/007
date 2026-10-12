import { describe, expect, test } from 'bun:test'

import { executeWorkflow } from './executor'
import { chainGraph, makeConfig } from './executor-test-helpers'
import { createMemoryRunRecorder } from './run-recorder'

// `wrapNode` is how the inline engine opens a Sentry span per node. These pin
// the contract it relies on: every executed node passes through it exactly
// once with its own sequence, and a failure inside surfaces through it.
describe('executor — wrapNode', () => {
  test('wraps every executed node once, with its recorded sequence', async () => {
    const recorder = createMemoryRunRecorder()
    const wrapped: { nodeId: string; sequence: number }[] = []
    await executeWorkflow({
      graph: chainGraph({ continueOnError: true }),
      triggerInput: { n: 1 },
      config: makeConfig(),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder,
      wrapNode: (node, sequence, run) => {
        wrapped.push({ nodeId: node.id, sequence })
        return run()
      },
    })

    // Trigger and Output are recorded by the executor itself, not dispatched.
    const executed = recorder.steps.filter(
      (s) => s.nodeKind !== 'trigger' && s.nodeKind !== 'output',
    )
    expect(wrapped.map((w) => w.nodeId).sort()).toEqual(
      executed.map((s) => s.nodeId).sort(),
    )
    for (const w of wrapped) {
      expect(executed.find((s) => s.nodeId === w.nodeId)?.sequence).toBe(
        w.sequence,
      )
    }
  })

  test("a node's failure reaches the wrapper, then fails the step", async () => {
    const recorder = createMemoryRunRecorder()
    const seen: string[] = []
    await expect(
      executeWorkflow({
        graph: chainGraph(),
        triggerInput: { n: 1 },
        config: makeConfig(),
        runContext: { subjectId: 'acme', triggerKind: 'go' },
        recorder,
        wrapNode: async (node, _sequence, run) => {
          try {
            return await run()
          } catch (err) {
            seen.push(node.id)
            throw err
          }
        },
      }),
    ).rejects.toThrow('boom failed')
    expect(seen).toEqual(['boom'])
    expect(recorder.steps.find((s) => s.nodeId === 'boom')?.status).toBe(
      'failed',
    )
  })
})
