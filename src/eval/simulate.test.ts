import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import type { ToolRegistry, WfSdkConfig } from '../engine'
import { runWorkflowUnderConditions } from './index'

// Phase 1 — the eval `simulate` signal + fixtures. Proves that under
// `runContext.simulate` a side-effecting tool is neutralized by its
// `sideEffect` tag: `write` tools no-op, `read` tools return their fixture (or
// an empty default), while an untagged (pure) tool still runs for real. No LLM,
// no database, no Cloudflare — the in-process eval harness records the trace.

type Deps = { calls: string[] }

// Records every real invocation into `deps.calls` so the test can assert a
// write tool truly did NOT run under simulate.
const toolRegistry: ToolRegistry<Deps> = new Map([
  [
    'update_document',
    {
      id: 'update_document',
      name: 'Update Document',
      kind: 'function',
      description: 'A write tool (side effect).',
      sideEffect: 'write',
      build: (deps) => (args) => {
        deps.calls.push('update_document')
        return Promise.resolve({ updated: true, args })
      },
    },
  ],
  [
    'search_kb',
    {
      id: 'search_kb',
      name: 'Knowledge Base Search',
      kind: 'function',
      description: 'A read tool (returns a fixture under simulate).',
      sideEffect: 'read',
      build: (deps) => () => {
        deps.calls.push('search_kb')
        return Promise.resolve({ docs: ['LIVE — should not appear'] })
      },
    },
  ],
  [
    'shout',
    {
      id: 'shout',
      name: 'Shout',
      kind: 'function',
      description: 'A pure compute tool (untagged — runs even under simulate).',
      build: () => (args) => {
        const { text } = args as { text: string }
        return Promise.resolve({ shouted: text.toUpperCase() })
      },
    },
  ],
])

function config(deps: Deps): WfSdkConfig<Deps> {
  return {
    getModel: () => {
      throw new Error('no model needed for a tool-only graph')
    },
    listModels: () => [],
    listProviders: () => [],
    toolRegistry,
    triggers: {
      go: { description: 'Go', inputSchema: z.object({ text: z.string() }) },
    },
    buildRunDeps: () => deps,
  }
}

// trigger → single tool node → output. `toolId` picks which tool to fire.
function graph(toolId: string, args: Record<string, unknown>) {
  return {
    version: 1,
    nodes: [
      {
        id: 't',
        kind: 'trigger',
        label: 'Go',
        position: { x: 0, y: 0 },
        config: { triggerKind: 'go' },
      },
      {
        id: 'tool1',
        kind: 'tool',
        label: toolId,
        position: { x: 200, y: 0 },
        config: { toolId, args },
      },
      {
        id: 'o',
        kind: 'output',
        label: 'Out',
        position: { x: 400, y: 0 },
        config: {},
      },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'tool1', condition: null },
      { id: 'e2', source: 'tool1', target: 'o', condition: null },
    ],
  }
}

describe('simulate signal + fixtures', () => {
  test('write tool no-ops under simulate (never really runs)', async () => {
    const deps: Deps = { calls: [] }
    const run = await runWorkflowUnderConditions({
      name: 'write-noop',
      graph: graph('update_document', {
        title: { kind: 'literal', value: 'x' },
      }),
      triggerInput: { text: 'hi' },
      config: config(deps),
      runContext: { simulate: true },
    })

    expect(deps.calls).toEqual([]) // the real write never fired
    expect(run.output).toEqual({ simulated: true })
    // The call is still recorded so a grader can assert it happened.
    expect(run.steps.some((s) => s.nodeId === 'tool1')).toBe(true)
  })

  test('read tool returns its fixture under simulate', async () => {
    const deps: Deps = { calls: [] }
    const run = await runWorkflowUnderConditions({
      name: 'read-fixture',
      graph: graph('search_kb', {}),
      triggerInput: { text: 'hi' },
      config: config(deps),
      runContext: {
        simulate: true,
        fixtures: { search_kb: { docs: ['CANNED'] } },
      },
    })

    expect(deps.calls).toEqual([]) // live read never fired
    expect(run.output).toEqual({ docs: ['CANNED'] })
  })

  test('read tool with no fixture falls back to an empty default', async () => {
    const deps: Deps = { calls: [] }
    const run = await runWorkflowUnderConditions({
      name: 'read-empty',
      graph: graph('search_kb', {}),
      triggerInput: { text: 'hi' },
      config: config(deps),
      runContext: { simulate: true }, // no fixtures supplied
    })

    expect(run.output).toEqual({})
  })

  test('untagged (pure) tool runs for real even under simulate', async () => {
    const deps: Deps = { calls: [] }
    const run = await runWorkflowUnderConditions({
      name: 'pure-runs',
      graph: graph('shout', {
        text: { kind: 'ref', nodeId: 't', path: 'text' },
      }),
      triggerInput: { text: 'hi' },
      config: config(deps),
      runContext: { simulate: true },
    })

    expect(run.output).toEqual({ shouted: 'HI' })
  })

  test('without simulate, a tagged write tool runs normally', async () => {
    const deps: Deps = { calls: [] }
    const run = await runWorkflowUnderConditions({
      name: 'no-simulate',
      graph: graph('update_document', {
        title: { kind: 'literal', value: 'x' },
      }),
      triggerInput: { text: 'hi' },
      config: config(deps),
    })

    expect(deps.calls).toEqual(['update_document']) // really ran
    expect(run.output).toMatchObject({ updated: true })
  })
})
