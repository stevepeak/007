import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import {
  buildIterationSubgraph,
  type ToolRegistry,
  type WfSdkConfig,
} from '../engine'
import { runWorkflowUnderConditions } from './index'

// End-to-end: a trigger emits a list, an iteration node maps a subgraph over it
// (item → shout tool → item result), and the outer output receives the ordered
// collection. Proves the in-process executor drives runNode → runIteration →
// executeSubgraph, records the iteration as a single step, and preserves order.

describe('eval harness — iteration graph', () => {
  type ToolDeps = { subject: string }

  const toolRegistry: ToolRegistry<ToolDeps> = new Map([
    [
      'shout',
      {
        id: 'shout',
        name: 'Shout',
        kind: 'function',
        description: 'Uppercases its text arg.',
        build: () => (args) => {
          const { text } = args as { text: string }
          return Promise.resolve({ shouted: text.toUpperCase() })
        },
      },
    ],
  ])

  const config: WfSdkConfig<ToolDeps> = {
    getModel: () => {
      throw new Error('no model needed')
    },
    listModels: () => [],
    listProviders: () => [],
    toolRegistry,
    triggers: {
      words: {
        description: 'A list of words',
        inputSchema: z.object({ words: z.array(z.string()) }),
      },
    },
    buildRunDeps: (ctx) => ({ subject: ctx.subjectId ?? '' }),
  }

  // Subgraph: iteration_item trigger → shout(text = the item) → item result.
  const subgraph = buildIterationSubgraph()
  const itemTriggerId = subgraph.nodes.find((n) => n.kind === 'trigger')!.id
  const itemOutputId = subgraph.nodes.find((n) => n.kind === 'output')!.id
  const shoutId = 'shout-item'
  subgraph.nodes.splice(1, 0, {
    id: shoutId,
    kind: 'tool',
    label: 'Shout item',
    position: { x: 160, y: 0 },
    config: {
      toolId: 'shout',
      args: { text: { kind: 'ref', nodeId: itemTriggerId, path: '' } },
    },
  })
  // Re-wire trigger → shout → output.
  subgraph.edges = [
    { id: 'se1', source: itemTriggerId, target: shoutId, condition: null },
    { id: 'se2', source: shoutId, target: itemOutputId, condition: null },
  ]

  const graph = {
    version: 1,
    nodes: [
      {
        id: 't',
        kind: 'trigger',
        label: 'Words',
        position: { x: 0, y: 0 },
        config: { triggerKind: 'words' },
      },
      {
        id: 'it',
        kind: 'iteration',
        label: 'Shout each',
        position: { x: 200, y: 0 },
        config: {
          source: { kind: 'ref', nodeId: 't', path: 'words' },
          concurrency: 3,
          stopOnError: false,
          subgraph,
        },
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
      { id: 'e1', source: 't', target: 'it', condition: null },
      { id: 'e2', source: 'it', target: 'o', condition: null },
    ],
  }

  test('maps the subgraph over the list and returns the ordered collection', async () => {
    const run = await runWorkflowUnderConditions({
      name: 'iteration graph',
      graph,
      triggerInput: { words: ['alpha', 'beta', 'gamma'] },
      config,
    })

    expect(run.output).toEqual([
      { shouted: 'ALPHA' },
      { shouted: 'BETA' },
      { shouted: 'GAMMA' },
    ])
    expect(run.outputNodeId).toBe('o')

    // The top-level trace is still trigger → iteration → output, with the whole
    // iteration rolled up into ONE step (output = the collection).
    const topLevel = run.steps.filter((s) => !s.parentNodeId)
    expect(topLevel.map((s) => s.nodeKind)).toEqual([
      'trigger',
      'iteration',
      'output',
    ])
    const iterStep = topLevel.find((s) => s.nodeKind === 'iteration')!
    expect(iterStep.status).toBe('completed')
    expect(iterStep.output).toHaveLength(3)
    const meta = iterStep.meta as { total: number; items: unknown[] }
    expect(meta.total).toBe(3)
    expect(meta.items).toHaveLength(3)

    // Each item ALSO records its inner subgraph nodes, scoped by the container
    // id + a 0-based item index — this is what lets the run viewer drill into a
    // single item's per-node trace. (Order is interleaved: items run
    // concurrently, so assert per-item content, not global sequence.)
    const sub = run.steps.filter((s) => s.parentNodeId === 'it')
    expect(new Set(sub.map((s) => s.itemIndex))).toEqual(new Set([0, 1, 2]))
    for (const idx of [0, 1, 2]) {
      const kinds = sub
        .filter((s) => s.itemIndex === idx)
        .map((s) => s.nodeKind)
        .sort()
      expect(kinds).toEqual(['output', 'tool', 'trigger'])
    }
  })

  test('empty list yields an empty collection', async () => {
    const run = await runWorkflowUnderConditions({
      name: 'iteration empty',
      graph,
      triggerInput: { words: [] },
      config,
    })
    expect(run.output).toEqual([])
  })

  // Regression for the "no forwarding" model: an iteration sitting BEHIND a
  // Branch (which emits only its decision) still reaches the producer's list by
  // ref — the Branch is pure control flow, not a data conduit.
  test('iteration behind a branch refs the producer directly', async () => {
    const branchGraph = {
      version: 1,
      nodes: [
        {
          id: 't',
          kind: 'trigger',
          label: 'Words',
          position: { x: 0, y: 0 },
          config: { triggerKind: 'words' },
        },
        {
          id: 'b',
          kind: 'branch',
          label: 'Any words?',
          position: { x: 160, y: 0 },
          config: {
            source: { kind: 'ref', nodeId: 't', path: 'words' },
            operator: 'is_not_empty',
          },
        },
        {
          id: 'it',
          kind: 'iteration',
          label: 'Shout each',
          position: { x: 320, y: 0 },
          config: {
            // Refs the trigger, NOT its direct predecessor (the branch).
            source: { kind: 'ref', nodeId: 't', path: 'words' },
            concurrency: 3,
            stopOnError: false,
            subgraph,
          },
        },
        {
          id: 'o',
          kind: 'output',
          label: 'Out',
          position: { x: 480, y: 0 },
          config: {},
        },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'b', condition: null },
        // Only the "yes" (non-empty) arm reaches the loop.
        { id: 'e2', source: 'b', target: 'it', condition: 'yes' },
        { id: 'e3', source: 'it', target: 'o', condition: null },
      ],
    }
    const run = await runWorkflowUnderConditions({
      name: 'iteration behind branch',
      graph: branchGraph,
      triggerInput: { words: ['alpha', 'beta'] },
      config,
    })
    expect(run.output).toEqual([{ shouted: 'ALPHA' }, { shouted: 'BETA' }])
  })
})
