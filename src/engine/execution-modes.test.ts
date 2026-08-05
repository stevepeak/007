import { describe, expect, test } from 'bun:test'

import { calleeEventType, toCalleeWire } from '../cloudflare/callee-protocol'
import { workflowGraphShapeSchema } from './graph'

// Where a node's work runs — an iteration's items, a workflow node's callee — is
// an author choice stored in the graph. These cover the part of that choice the
// engine owns: what an un-annotated graph means, and that the two settings are
// independent of one another.

const pos = { x: 0, y: 0 }

const parse = (nodes: unknown[]) =>
  workflowGraphShapeSchema.parse({ version: 1, nodes, edges: [] })

const iterationNode = (config: Record<string, unknown> = {}) => ({
  id: 'loop',
  kind: 'iteration',
  position: pos,
  label: 'Loop',
  config: {
    source: { kind: 'ref', nodeId: 't', path: '' },
    // Minimal valid subgraph: the Item bookend wired to its Output.
    subgraph: {
      version: 1,
      nodes: [
        {
          id: 'it',
          kind: 'trigger',
          position: pos,
          label: 'Item',
          config: { triggerKind: 'iteration_item' },
        },
        {
          id: 'res',
          kind: 'output',
          position: pos,
          label: 'Result',
          config: { source: { kind: 'ref', nodeId: 'it', path: '' } },
        },
      ],
      edges: [{ id: 'e', source: 'it', target: 'res', condition: null }],
    },
    ...config,
  },
})

const workflowNode = (config: Record<string, unknown> = {}) => ({
  id: 'call',
  kind: 'workflow',
  position: pos,
  label: 'Call',
  config: { workflowId: 'w1', ...config },
})

describe('execution modes', () => {
  // The default is load-bearing: every graph authored before the setting existed
  // has no `itemExecution`/`calleeExecution` at all, and must keep running
  // exactly as it did — as one unit per item / per callee.
  test('a graph with no setting means inline', () => {
    const g = parse([iterationNode(), workflowNode()])
    const [loop, call] = g.nodes
    expect(loop.kind === 'iteration' && loop.config.itemExecution).toBe('inline')
    expect(call.kind === 'workflow' && call.config.calleeExecution).toBe(
      'inline',
    )
  })

  test('an explicit durable setting round-trips', () => {
    const g = parse([
      iterationNode({ itemExecution: 'durable' }),
      workflowNode({ calleeExecution: 'durable' }),
    ])
    const [loop, call] = g.nodes
    expect(loop.kind === 'iteration' && loop.config.itemExecution).toBe(
      'durable',
    )
    expect(call.kind === 'workflow' && call.config.calleeExecution).toBe(
      'durable',
    )
  })

  test('an unknown mode is rejected rather than silently defaulted', () => {
    expect(() => parse([workflowNode({ calleeExecution: 'spawn' })])).toThrow()
  })

  // A parent can have several durable callees parked at once. Keying the event
  // type on the node id is what stops one node's completion waking a sibling —
  // which would hand that sibling the wrong workflow's output.
  test('each calling node parks on its own event type', () => {
    expect(calleeEventType('a')).not.toBe(calleeEventType('b'))
    expect(calleeEventType('a')).toBe(calleeEventType('a'))
  })

  // `undefined` is what a callee whose Output fizzled out returns. It must
  // survive as a JSON `null` rather than an absent field, or the parent's
  // `JSON.parse` gets an empty string and throws — turning a legitimately
  // empty result into a crash in the caller.
  test('an empty callee result crosses the wire as null', () => {
    const wire = toCalleeWire({ ok: true, output: undefined })
    expect(wire).toEqual({ ok: true, outputJson: 'null' })
    expect(JSON.parse((wire as { outputJson: string }).outputJson)).toBeNull()
  })
})
