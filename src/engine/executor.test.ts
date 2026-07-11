import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import type { RunCompletion, RunFailure, WfSdkConfig } from './config'
import { executeWorkflow } from './executor'
import { workflowGraphSchema } from './graph'
import { createMemoryRunRecorder } from './run-recorder'
import type { ToolRegistry } from './tool-registry'

// Covers the three SDK capabilities added for the recipe-ingestion redesign,
// all through the in-process backend (no DB, no Cloudflare):
//   1. onRunComplete / onRunFailed lifecycle callbacks
//   2. per-node `continueOnError` (best-effort nodes)
//   3. the provider-agnostic `execution` policy schema (retry/timeout shape)
// The Cloudflare backend maps #2/#3 onto `step.do`; that mapping can't be
// imported here (it pulls in `cloudflare:workers`), so we assert the engine-side
// contract both backends share.

type Deps = { tenant: string }

const toolRegistry: ToolRegistry<Deps> = new Map([
  [
    'boom',
    {
      id: 'boom',
      name: 'Boom',
      kind: 'function',
      description: 'Always throws.',
      build: () => async () => {
        throw new Error('boom failed')
      },
    },
  ],
  [
    'after',
    {
      id: 'after',
      name: 'After',
      kind: 'function',
      description: 'Returns a constant regardless of input.',
      build: () => () => Promise.resolve({ ok: true }),
    },
  ],
])

function makeConfig(
  hooks: Partial<Pick<WfSdkConfig<Deps>, 'onRunComplete' | 'onRunFailed'>> = {},
): WfSdkConfig<Deps> {
  return {
    getModel: () => {
      throw new Error('no model needed')
    },
    listModels: () => [],
    toolRegistry,
    triggers: {
      go: { description: 'Go', inputSchema: z.object({ n: z.number() }) },
    },
    buildRunDeps: (ctx) => ({ tenant: ctx.tenantId }),
    ...hooks,
  }
}

// trigger → boom → after → output. `boom` always fails; whether the run aborts
// or reaches `after`/output is decided by boom's `execution.continueOnError`.
function chainGraph(boomExecution?: Record<string, unknown>) {
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
        id: 'boom',
        kind: 'tool',
        label: 'Boom',
        position: { x: 200, y: 0 },
        ...(boomExecution ? { execution: boomExecution } : {}),
        config: { toolId: 'boom', args: {} },
      },
      {
        id: 'after',
        kind: 'tool',
        label: 'After',
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
      { id: 'e1', source: 't', target: 'boom', condition: null },
      { id: 'e2', source: 'boom', target: 'after', condition: null },
      { id: 'e3', source: 'after', target: 'o', condition: null },
    ],
  }
}

describe('executor — continueOnError', () => {
  test('a best-effort node failure is recorded but the run continues', async () => {
    const recorder = createMemoryRunRecorder()
    const result = await executeWorkflow({
      graph: chainGraph({ continueOnError: true }),
      triggerInput: { n: 1 },
      config: makeConfig(),
      runContext: { tenantId: 'acme', triggerKind: 'go' },
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
        runContext: { tenantId: 'acme', triggerKind: 'go' },
        recorder,
      }),
    ).rejects.toThrow('boom failed')
    // `after` never ran.
    expect(recorder.steps.some((s) => s.nodeId === 'after')).toBe(false)
  })
})

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
      runContext: { tenantId: 'acme', triggerKind: 'go' },
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
        runContext: { tenantId: 'acme', triggerKind: 'go' },
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
      runContext: { tenantId: 'acme', triggerKind: 'go' },
      recorder: createMemoryRunRecorder(),
    })
    expect(result.output).toEqual({ ok: true })
  })
})

describe('graph schema — node execution policy', () => {
  test('accepts a node with a full execution policy', () => {
    const parsed = workflowGraphSchema.parse(
      chainGraph({
        continueOnError: true,
        timeoutMs: 120_000,
        retries: { limit: 1, delayMs: 2_000, backoff: 'exponential' },
      }),
    )
    const boom = parsed.nodes.find((n) => n.id === 'boom')
    expect(boom?.execution).toEqual({
      continueOnError: true,
      timeoutMs: 120_000,
      retries: { limit: 1, delayMs: 2_000, backoff: 'exponential' },
    })
  })

  test('rejects a non-positive timeout', () => {
    expect(() =>
      workflowGraphSchema.parse(chainGraph({ timeoutMs: 0 })),
    ).toThrow()
  })

  test('a node with no execution policy parses (field stays undefined)', () => {
    const parsed = workflowGraphSchema.parse(chainGraph())
    expect(parsed.nodes.find((n) => n.id === 'boom')?.execution).toBeUndefined()
  })
})
