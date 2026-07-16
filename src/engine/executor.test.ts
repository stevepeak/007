import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import type { RunCompletion, RunFailure, WfSdkConfig } from './config'
import { executeWorkflow } from './executor'
import { workflowGraphSchema } from './graph'
import { createMemoryRunRecorder } from './run-recorder'
import { WorkflowStalledError } from './scheduler'
import type { ToolRegistry } from './tool-registry'

// Covers the three SDK capabilities added for the recipe-ingestion redesign,
// all through the in-process backend (no DB, no Cloudflare):
//   1. onRunComplete / onRunFailed lifecycle callbacks
//   2. per-node `continueOnError` (best-effort nodes)
//   3. the provider-agnostic `execution` policy schema (retry/timeout shape)
// The Cloudflare backend maps #2/#3 onto `step.do`; that mapping can't be
// imported here (it pulls in `cloudflare:workers`), so we assert the engine-side
// contract both backends share.

type Deps = { subject: string }

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
  [
    'left',
    {
      id: 'left',
      name: 'Left',
      kind: 'function',
      description: 'Produces the left result.',
      build: () => () => Promise.resolve({ v: 'L' }),
    },
  ],
  [
    'right',
    {
      id: 'right',
      name: 'Right',
      kind: 'function',
      description: 'Produces the right result.',
      build: () => () => Promise.resolve({ v: 'R' }),
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
    listProviders: () => [],
    toolRegistry,
    triggers: {
      go: { description: 'Go', inputSchema: z.object({ n: z.number() }) },
    },
    buildRunDeps: (ctx) => ({ subject: ctx.subjectId ?? '' }),
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

// trigger → {left, right} producers → aggregate → output. The two producers run
// in parallel; the aggregate waits for both and collects their outputs into one
// ordered list (edge-declaration order), which becomes the run output.
function aggregateGraph() {
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
        id: 'left',
        kind: 'tool',
        label: 'Left',
        position: { x: 200, y: -50 },
        config: { toolId: 'left', args: {} },
      },
      {
        id: 'right',
        kind: 'tool',
        label: 'Right',
        position: { x: 200, y: 50 },
        config: { toolId: 'right', args: {} },
      },
      {
        id: 'agg',
        kind: 'aggregate',
        label: 'Aggregate',
        position: { x: 400, y: 0 },
        config: {},
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
      { id: 'e1', source: 't', target: 'left', condition: null },
      { id: 'e2', source: 't', target: 'right', condition: null },
      { id: 'e3', source: 'left', target: 'agg', condition: null },
      { id: 'e4', source: 'right', target: 'agg', condition: null },
      { id: 'e5', source: 'agg', target: 'o', condition: null },
    ],
  }
}

describe('executor — aggregate node', () => {
  test('collects parallel producers into an ordered list', async () => {
    const recorder = createMemoryRunRecorder()
    const result = await executeWorkflow({
      graph: aggregateGraph(),
      triggerInput: { n: 1 },
      config: makeConfig(),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder,
    })

    // One element per producer, in edge-declaration order (left, right).
    expect(result.output).toEqual([{ v: 'L' }, { v: 'R' }])
    expect(result.outputNodeId).toBe('o')

    const agg = recorder.steps.find((s) => s.nodeId === 'agg')
    expect(agg?.status).toBe('completed')
    expect(agg?.output).toEqual([{ v: 'L' }, { v: 'R' }])
    // The executor records the collect count as node meta.
    expect(agg?.meta).toEqual({ count: 2 })
  })
})

// trigger → switch(on `kind`) → [text|image|default] tool → its own output.
// Each arm routes to a distinct output so the run returns the arm that fired.
function switchGraph() {
  const armTool = (id: string, toolId: string, x: number) => ({
    id,
    kind: 'tool' as const,
    label: id,
    position: { x, y: 0 },
    config: { toolId, args: {} },
  })
  const armOut = (id: string, x: number) => ({
    id,
    kind: 'output' as const,
    label: id,
    position: { x, y: 0 },
    config: {},
  })
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
        id: 'sw',
        kind: 'switch',
        label: 'By kind',
        position: { x: 200, y: 0 },
        config: {
          path: 'kind',
          cases: [
            { key: 'text', value: 'text' },
            { key: 'image', value: 'image' },
          ],
        },
      },
      armTool('text-tool', 'label-text', 400),
      armTool('image-tool', 'label-image', 400),
      armTool('default-tool', 'label-default', 400),
      armOut('text-out', 600),
      armOut('image-out', 600),
      armOut('default-out', 600),
    ],
    edges: [
      { id: 'e0', source: 't', target: 'sw', condition: null },
      { id: 'e-text', source: 'sw', target: 'text-tool', condition: 'text' },
      { id: 'e-image', source: 'sw', target: 'image-tool', condition: 'image' },
      {
        id: 'e-def',
        source: 'sw',
        target: 'default-tool',
        condition: 'default',
      },
      { id: 'e-to', source: 'text-tool', target: 'text-out', condition: null },
      {
        id: 'e-io',
        source: 'image-tool',
        target: 'image-out',
        condition: null,
      },
      {
        id: 'e-do',
        source: 'default-tool',
        target: 'default-out',
        condition: null,
      },
    ],
  }
}

// Distinct constant per arm so the returned output identifies the arm that ran.
const switchTools: ToolRegistry<Deps> = new Map(
  (['text', 'image', 'default'] as const).map((k) => [
    `label-${k}`,
    {
      id: `label-${k}`,
      name: k,
      kind: 'function',
      description: k,
      build: () => () => Promise.resolve({ arm: k }),
    },
  ]),
)

function switchConfig(): WfSdkConfig<Deps> {
  return {
    getModel: () => {
      throw new Error('no model needed')
    },
    listModels: () => [],
    listProviders: () => [],
    toolRegistry: switchTools,
    triggers: {
      go: { description: 'Go', inputSchema: z.object({ kind: z.string() }) },
    },
    buildRunDeps: (ctx) => ({ subject: ctx.subjectId ?? '' }),
  }
}

describe('executor — switch (multi-way routing)', () => {
  test('routes to the matching case arm', async () => {
    const recorder = createMemoryRunRecorder()
    const result = await executeWorkflow({
      graph: switchGraph(),
      triggerInput: { kind: 'image' },
      config: switchConfig(),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder,
    })
    expect(result.output).toEqual({ arm: 'image' })
    expect(result.outputNodeId).toBe('image-out')
    // The switch step records its decision as the winning case key.
    const sw = recorder.steps.find((s) => s.nodeId === 'sw')
    expect(sw?.branchResult?.result).toBe('image')
    // The other arms never ran.
    expect(recorder.steps.some((s) => s.nodeId === 'text-tool')).toBe(false)
    expect(recorder.steps.some((s) => s.nodeId === 'default-tool')).toBe(false)
  })

  test('falls back to the default arm when no case matches', async () => {
    const result = await executeWorkflow({
      graph: switchGraph(),
      triggerInput: { kind: 'audio' },
      config: switchConfig(),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder: createMemoryRunRecorder(),
    })
    expect(result.output).toEqual({ arm: 'default' })
    expect(result.outputNodeId).toBe('default-out')
  })

  test('rejects a switch missing its default edge', () => {
    const g = switchGraph()
    g.edges = g.edges.filter((e) => e.id !== 'e-def')
    expect(() => workflowGraphSchema.parse(g)).toThrow(/default/)
  })

  test('rejects an outgoing edge matching no declared case', () => {
    const g = switchGraph()
    g.edges = g.edges.map((e) =>
      e.id === 'e-text' ? { ...e, condition: 'nope' } : e,
    )
    expect(() => workflowGraphSchema.parse(g)).toThrow(/matches no declared case/)
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
