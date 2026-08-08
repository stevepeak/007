import { describe, expect, test } from 'bun:test'

import { calleeEventType, toCalleeWire } from '../cloudflare/callee-protocol'
import {
  backfillIterationLimits,
  ITERATION_MAX_ITEMS_CEILING,
  ITERATION_MAX_ITEMS_DEFAULT,
  workflowGraphShapeSchema,
} from './graph'

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

// The fan-out bound rides the same lifecycle as `itemExecution` — stored in the
// graph, versioned with it — but with the opposite default policy: unset must
// stay unset through a parse, because "the author never chose" is the state the
// Issues panel reports and the run-time fallback answers.
describe('iteration fan-out bound', () => {
  // The shape schema needs two nodes; the workflow node is inert filler.
  const graphWith = (config: Record<string, unknown> = {}) =>
    parse([iterationNode(config), workflowNode()])

  const boundOf = (graph: ReturnType<typeof parse>) => {
    const [loop] = graph.nodes
    return loop.kind === 'iteration' ? loop.config.maxItems : null
  }

  test('a graph with no bound parses as unbound, not as a default', () => {
    expect(boundOf(graphWith())).toBeUndefined()
  })

  test('an explicit bound round-trips', () => {
    expect(boundOf(graphWith({ maxItems: 25 }))).toBe(25)
  })

  test('an over-ceiling bound still SAVES', () => {
    // The editor's contract: a graph with issues must persist. Too high is an
    // authoring error to surface, never a reason to reject the save.
    const over = ITERATION_MAX_ITEMS_CEILING.inline + 500
    expect(boundOf(graphWith({ maxItems: over }))).toBe(over)
  })

  test('a nonsense bound is rejected rather than silently coerced', () => {
    expect(() => graphWith({ maxItems: 0 })).toThrow()
    expect(() => graphWith({ maxItems: 2.5 })).toThrow()
  })

  test('the publish backfill bounds a legacy node, per its mode', () => {
    expect(boundOf(backfillIterationLimits(graphWith()))).toBe(
      ITERATION_MAX_ITEMS_DEFAULT.inline,
    )
    // The mode decides the number written in, same as the ceiling does.
    expect(
      boundOf(backfillIterationLimits(graphWith({ itemExecution: 'durable' }))),
    ).toBe(ITERATION_MAX_ITEMS_DEFAULT.durable)
  })

  test('the backfill never overwrites a bound the author chose', () => {
    // Including one above the ceiling: that's an error to fix in the editor, not
    // a value to silently rewrite under them at publish.
    const over = ITERATION_MAX_ITEMS_CEILING.inline + 1
    expect(
      boundOf(backfillIterationLimits(graphWith({ maxItems: over }))),
    ).toBe(over)
    // Nothing to fill → the same object, so publishing an already-bounded graph
    // doesn't churn its JSON.
    const g = graphWith({ maxItems: 10 })
    expect(backfillIterationLimits(g)).toBe(g)
  })

  test('the backfill reaches an iteration nested in a subgraph', () => {
    // The strict run gate rejects nested iteration, but the SHAPE schema saves
    // it — so a published version can hold one, and it needs a bound like any
    // other loop rather than being skipped for sitting a level down.
    const inner = iterationNode()
    const outer = iterationNode()
    outer.config.subgraph.nodes.push(inner as never)
    const filled = backfillIterationLimits(parse([outer, workflowNode()]))
    const [loop] = filled.nodes
    const nested =
      loop.kind === 'iteration'
        ? loop.config.subgraph.nodes.find((n) => n.kind === 'iteration')
        : undefined
    expect(nested?.kind === 'iteration' && nested.config.maxItems).toBe(
      ITERATION_MAX_ITEMS_DEFAULT.inline,
    )
  })
})
