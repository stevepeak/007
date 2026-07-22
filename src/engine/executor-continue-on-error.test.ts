import { describe, expect, test } from 'bun:test'

import { executeWorkflow } from './executor'
import { createMemoryRunRecorder } from './run-recorder'
import { chainGraph, makeConfig } from './executor-test-helpers'

describe('executor — continueOnError', () => {
  test('a best-effort node failure is recorded but the run continues', async () => {
    const recorder = createMemoryRunRecorder()
    const result = await executeWorkflow({
      graph: chainGraph({ continueOnError: true }),
      triggerInput: { n: 1 },
      config: makeConfig(),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder,
    })

    // Downstream node ran and the run reached the output despite boom failing.
    expect(result.output).toEqual({ ok: true })
    expect(result.outputNodeId).toBe('o')

    const boom = recorder.steps.find((s) => s.nodeId === 'boom')
    expect(boom?.status).toBe('failed')
    expect(boom?.error).toBe('boom failed')
    // The failure stays visible in the trace, but `after` still completed.
    expect(recorder.steps.find((s) => s.nodeId === 'after')?.status).toBe(
      'completed',
    )
  })

  test('without continueOnError the same failure aborts the run', async () => {
    const recorder = createMemoryRunRecorder()
    await expect(
      executeWorkflow({
        graph: chainGraph(),
        triggerInput: { n: 1 },
        config: makeConfig(),
        runContext: { subjectId: 'acme', triggerKind: 'go' },
        recorder,
      }),
    ).rejects.toThrow('boom failed')
    // `after` never ran.
    expect(recorder.steps.some((s) => s.nodeId === 'after')).toBe(false)
  })
})
