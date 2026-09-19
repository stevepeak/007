import { describe, expect, test } from 'bun:test'

import { nodeRefs, stripGraphRefsTo, stripNodeRefsTo } from './graph-bindings'
import type { WorkflowGraph, WorkflowNode } from './graph-schema'

const pos = { x: 0, y: 0 }
function ref(nodeId: string, path = '') {
  return {
    kind: 'ref' as const,
    nodeId,
    path,
  }
}
const lit = (value: unknown) => ({ kind: 'literal' as const, value })

const agent: WorkflowNode = {
  id: 'a',
  kind: 'agent',
  position: pos,
  label: 'A',
  informUser: { mode: 'off' },
  config: {
    agentId: 'x',
    version: null,
    inputs: { q: ref('b', 'text'), name: lit('n'), other: ref('c') },
    conversation: ref('b', 'messages'),
  },
}

describe('nodeRefs', () => {
  test('lists every ref on a node with its slot, skipping literals', () => {
    expect(nodeRefs(agent)).toEqual([
      { slot: "input 'q'", ref: ref('b', 'text') },
      { slot: "input 'other'", ref: ref('c') },
      { slot: 'conversation', ref: ref('b', 'messages') },
    ])
  })

  test('covers switch source and case values', () => {
    const sw: WorkflowNode = {
      id: 's',
      kind: 'switch',
      position: pos,
      label: 'S',
      informUser: { mode: 'off' },
      config: {
        source: ref('b', 'decision'),
        cases: [
          { key: 'A', label: 'Flag', value: lit('FLAG') },
          { key: 'B', value: ref('c', 'expected') },
        ],
      },
    }
    expect(nodeRefs(sw).map((r) => r.slot)).toEqual(['source', "case 'B'"])
  })
})

describe('stripNodeRefsTo', () => {
  test('drops record entries and single bindings that point at a removed node', () => {
    const next = stripNodeRefsTo(agent, new Set(['b']))
    expect(next.kind === 'agent' && next.config).toEqual({
      agentId: 'x',
      version: null,
      inputs: { name: lit('n'), other: ref('c') },
      conversation: undefined,
    })
  })

  test('leaves a node untouched when nothing points at the removed id', () => {
    expect(stripNodeRefsTo(agent, new Set(['zzz']))).toEqual(agent)
  })

  test('a switch case bound to a removed node falls back to an empty literal', () => {
    const sw: WorkflowNode = {
      id: 's',
      kind: 'switch',
      position: pos,
      label: 'S',
      informUser: { mode: 'off' },
      config: {
        source: ref('b'),
        cases: [{ key: 'A', value: ref('b', 'v') }],
      },
    }
    const next = stripNodeRefsTo(sw, new Set(['b']))
    expect(next.kind === 'switch' && next.config).toEqual({
      source: undefined,
      cases: [{ key: 'A', value: lit('') }],
    })
  })

  test('descends into an iteration subgraph', () => {
    const iteration: WorkflowNode = {
      id: 'it',
      kind: 'iteration',
      position: pos,
      label: 'Loop',
      informUser: { mode: 'off' },
      config: {
        source: ref('b', 'items'),
        concurrency: 1,
        stopOnError: false,
        itemExecution: 'inline',
        itemTitle: '',
        maxItems: 10,
        subgraph: {
          version: 1,
          nodes: [
            {
              id: 'out',
              kind: 'output',
              position: pos,
              label: 'Result',
              informUser: { mode: 'off' },
              config: { source: ref('inner') },
            },
          ],
          edges: [],
        },
      },
    }
    const g: WorkflowGraph = { version: 1, nodes: [iteration], edges: [] }
    const next = stripGraphRefsTo(g, new Set(['b', 'inner']))
    const it = next.nodes[0]
    expect(it?.kind === 'iteration' && it.config.source).toBeUndefined()
    const out = it?.kind === 'iteration' ? it.config.subgraph.nodes[0] : null
    expect(out?.kind === 'output' && out.config.source).toBeUndefined()
  })
})
