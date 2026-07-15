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
          itemsPath: 'words',
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

    // The whole iteration is recorded as ONE step (output = the collection).
    expect(run.steps.map((s) => s.nodeKind)).toEqual([
      'trigger',
      'iteration',
      'output',
    ])
    const iterStep = run.steps.find((s) => s.nodeKind === 'iteration')!
    expect(iterStep.status).toBe('completed')
    expect(iterStep.output).toHaveLength(3)
    const meta = iterStep.meta as { total: number; items: unknown[] }
    expect(meta.total).toBe(3)
    expect(meta.items).toHaveLength(3)
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
})
