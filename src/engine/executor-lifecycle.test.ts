import { describe, expect, test } from 'bun:test'

import type { RunCompletion, RunFailure } from './config'
import { executeWorkflow } from './executor'
import { createMemoryRunRecorder } from './run-recorder'
import { chainGraph, makeConfig } from './executor-test-helpers'

describe('executor — lifecycle callbacks', () => {
  test('onRunComplete fires once with the run output', async () => {
    let seen: RunCompletion | undefined
    await executeWorkflow({
      graph: chainGraph({ continueOnError: true }),
      triggerInput: { n: 1 },
      config: makeConfig({
        onRunComplete: (_ctx, result) => {
          seen = result
        },
      }),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder: createMemoryRunRecorder(),
    })
    expect(seen).toEqual({ output: { ok: true }, outputNodeId: 'o' })
  })

  test('onRunFailed fires with the error when the run aborts', async () => {
    let failure: RunFailure | undefined
    await expect(
      executeWorkflow({
        graph: chainGraph(),
        triggerInput: { n: 1 },
        config: makeConfig({
          onRunFailed: (_ctx, f) => {
            failure = f
          },
        }),
        runContext: { subjectId: 'acme', triggerKind: 'go' },
        recorder: createMemoryRunRecorder(),
      }),
    ).rejects.toThrow('boom failed')
    expect(failure).toEqual({ error: 'boom failed' })
  })

  test('a throwing callback is swallowed and never changes the outcome', async () => {
    // The completed run must still resolve even if the host callback blows up.
    const result = await executeWorkflow({
      graph: chainGraph({ continueOnError: true }),
      triggerInput: { n: 1 },
      config: makeConfig({
        onRunComplete: () => {
          throw new Error('host callback exploded')
        },
      }),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder: createMemoryRunRecorder(),
    })
    expect(result.output).toEqual({ ok: true })
  })
})
