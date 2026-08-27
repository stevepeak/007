import { describe, expect, test } from 'bun:test'

import {
  ITERATION_MAX_ITEMS_CEILING,
  workflowGraphShapeSchema,
  type WorkflowGraph,
  type WorkflowNode,
} from './graph'
import { collectGraphIssues } from './graph-issues'

const pos = { x: 0, y: 0 }

// Fixtures model a PARSED graph — `collectGraphIssues` runs on the output of
// `workflowGraphSchema`, never on raw authored JSON. That distinction matters
// for `informUser`: the schema declares it `.default({ mode: 'off' })`, so it is
// optional on the way in and REQUIRED on the way out. Annotating each builder
// `WorkflowNode` pins them to the parsed shape, which is what caught these
// fixtures having drifted off it entirely.
const trigger: WorkflowNode = {
  id: 't',
  kind: 'trigger',
  position: pos,
  label: 'Start',
  informUser: { mode: 'off' },
  config: { triggerKind: 'chat_message' },
}
function output (id = 'o', source?: string): WorkflowNode {
  return {
  id,
  kind: 'output',
  position: pos,
  label: id,
  informUser: { mode: 'off' },
  config: source ? { source: { kind: 'ref', nodeId: source, path: '' } } : {},
}
}
function agent (id: string, agentId = 'a1'): WorkflowNode {
  return {
  id,
  kind: 'agent',
  position: pos,
  label: id,
  informUser: { mode: 'off' },
  config: { agentId, version: null, inputs: {} },
}
}
function branch (id: string): WorkflowNode {
  return {
  id,
  kind: 'branch',
  position: pos,
  label: id,
  informUser: { mode: 'off' },
  config: { operator: 'is_not_empty' },
}
}
function tool (id: string): WorkflowNode {
  return {
  id,
  kind: 'tool',
  position: pos,
  label: id,
  informUser: { mode: 'off' },
  config: { toolId: 't1', args: {} },
}
}
function race (id: string): WorkflowNode {
  return {
  id,
  kind: 'race',
  position: pos,
  label: id,
  informUser: { mode: 'off' },
  config: {},
}
}
function edge (source: string,
  target: string,
  condition: 'yes' | 'no' | null = null) {
  return { id: `${source}->${target}`, source, target, condition }
}

function graph(
  nodes: WorkflowGraph['nodes'],
  edges: WorkflowGraph['edges'],
): WorkflowGraph {
  return { version: 1, nodes, edges }
}

describe('collectGraphIssues', () => {
  test('a clean linear graph has no issues', () => {
    const g = graph(
      [trigger, agent('x'), output('o', 'x')],
      [edge('t', 'x'), edge('x', 'o')],
    )
    expect(collectGraphIssues(g)).toEqual([])
  })

  test('flags an agent node with no agent selected, attributed to that node', () => {
    const g = graph(
      [trigger, agent('x', ''), output()],
      [edge('t', 'x'), edge('x', 'o')],
    )
    const issues = collectGraphIssues(g)
    const cfg = issues.find(
      (i) => i.nodeId === 'x' && /No agent/.test(i.message),
    )
    expect(cfg?.severity).toBe('error')
  })

  test('flags a disconnected node as an error', () => {
    const g = graph(
      [trigger, agent('x'), agent('orphan'), output()],
      [edge('t', 'x'), edge('x', 'o')],
    )
    const issues = collectGraphIssues(g)
    expect(
      issues.some((i) => i.nodeId === 'orphan' && i.severity === 'error'),
    ).toBe(true)
  })

  test('allows a same-arm fan-in join but flags a both-arms join', () => {
    // Same-arm: branch no→x, x fans to p&q, both join at `j`. No join error.
    const sameArm = graph(
      [
        trigger,
        branch('b'),
        agent('x'),
        agent('p'),
        agent('q'),
        agent('j'),
        output('o'),
        output('oy'),
      ],
      [
        edge('t', 'b'),
        edge('b', 'x', 'no'),
        edge('b', 'oy', 'yes'),
        edge('x', 'p'),
        edge('x', 'q'),
        edge('p', 'j'),
        edge('q', 'j'),
        edge('j', 'o'),
      ],
    )
    expect(
      collectGraphIssues(sameArm).some((i) => /both arms/.test(i.message)),
    ).toBe(false)

    // Both-arms: branch yes→u, no→v, both join at `j` → mutually exclusive.
    const bothArms = graph(
      [trigger, branch('b'), agent('u'), agent('v'), agent('j'), output('o')],
      [
        edge('t', 'b'),
        edge('b', 'u', 'yes'),
        edge('b', 'v', 'no'),
        edge('u', 'j'),
        edge('v', 'j'),
        edge('j', 'o'),
      ],
    )
    expect(
      collectGraphIssues(bothArms).some(
        (i) => i.nodeId === 'j' && /both arms/.test(i.message),
      ),
    ).toBe(true)
  })

  test('a race is exempt from both the parallel-merge and both-arms join rules', () => {
    // Two always-live parallel producers into one race — the point of the node,
    // not the "parallel merge" error a work node/Output would raise.
    const parallel = graph(
      [trigger, agent('a'), agent('b'), race('r'), output('o')],
      [
        edge('t', 'a'),
        edge('t', 'b'),
        edge('a', 'r'),
        edge('b', 'r'),
        edge('r', 'o'),
      ],
    )
    expect(
      collectGraphIssues(parallel).some((i) =>
        /parallel|both arms/.test(i.message),
      ),
    ).toBe(false)

    // Both arms of a branch converging on a race is legal too — first arm to run
    // wins, so it can never stall the way a normal both-arms join would.
    const bothArms = graph(
      [trigger, branch('b'), agent('u'), agent('v'), race('r'), output('o')],
      [
        edge('t', 'b'),
        edge('b', 'u', 'yes'),
        edge('b', 'v', 'no'),
        edge('u', 'r'),
        edge('v', 'r'),
        edge('r', 'o'),
      ],
    )
    expect(
      collectGraphIssues(bothArms).some(
        (i) => i.nodeId === 'r' && /both arms/.test(i.message),
      ),
    ).toBe(false)
  })

  test('a work node downstream of a branch-joining race is not flagged', () => {
    // branch yes→race, no→v→race, then race→j (a work node). The race collapses
    // the branch, so `j` never joins both arms — the cone must be sealed at the
    // race. This is the "Ingest document" Save-enrichment shape.
    const g = graph(
      [trigger, branch('b'), agent('v'), race('r'), agent('j'), output('o')],
      [
        edge('t', 'b'),
        edge('b', 'r', 'yes'),
        edge('b', 'v', 'no'),
        edge('v', 'r'),
        edge('r', 'j'),
        edge('j', 'o'),
      ],
    )
    expect(
      collectGraphIssues(g).some((i) => /both arms/.test(i.message)),
    ).toBe(false)
  })

  test('still flags a work node when an arm bypasses the race', () => {
    // yes→race→j, but no→j directly. The direct arm keeps both arms in j's cone,
    // so the stall is real and the race seal must not hide it.
    const g = graph(
      [trigger, branch('b'), race('r'), agent('j'), output('o')],
      [
        edge('t', 'b'),
        edge('b', 'r', 'yes'),
        edge('r', 'j'),
        edge('b', 'j', 'no'),
        edge('j', 'o'),
      ],
    )
    expect(
      collectGraphIssues(g).some(
        (i) => i.nodeId === 'j' && /both arms/.test(i.message),
      ),
    ).toBe(true)
  })

  test('warns when a race has only one input', () => {
    const g = graph(
      [trigger, agent('a'), race('r'), output('o')],
      [edge('t', 'a'), edge('a', 'r'), edge('r', 'o')],
    )
    expect(
      collectGraphIssues(g).some(
        (i) => i.nodeId === 'r' && i.severity === 'warning' && /2\+/.test(i.message),
      ),
    ).toBe(true)
  })

  test('treats a YES/NO agent (conditioned edges) as a decision source', () => {
    // A boolean-output agent carries its own yes/no edges — no branch node. Its
    // two arms converging on one Output is legal (mutually exclusive), and its
    // arms joining one work node is the both-arms stall, exactly like a branch.
    const converge = graph(
      [trigger, agent('ask'), agent('u'), agent('v'), output('o')],
      [
        edge('t', 'ask'),
        edge('ask', 'u', 'yes'),
        edge('ask', 'v', 'no'),
        edge('u', 'o'),
        edge('v', 'o'),
      ],
    )
    expect(
      collectGraphIssues(converge).some((i) => /parallel|both arms/.test(i.message)),
    ).toBe(false)

    const join = graph(
      [trigger, agent('ask'), agent('u'), agent('v'), agent('j'), output('o')],
      [
        edge('t', 'ask'),
        edge('ask', 'u', 'yes'),
        edge('ask', 'v', 'no'),
        edge('u', 'j'),
        edge('v', 'j'),
        edge('j', 'o'),
      ],
    )
    expect(
      collectGraphIssues(join).some(
        (i) => i.nodeId === 'j' && /both arms/.test(i.message),
      ),
    ).toBe(true)
  })

  test('shape schema persists a graph that has integrity issues', () => {
    // A both-arms join is rejected by the strict schema but must still SAVE.
    const bad = graph(
      [trigger, branch('b'), agent('u'), agent('v'), agent('j'), output('o')],
      [
        edge('t', 'b'),
        edge('b', 'u', 'yes'),
        edge('b', 'v', 'no'),
        edge('u', 'j'),
        edge('v', 'j'),
        edge('j', 'o'),
      ],
    )
    expect(() => workflowGraphShapeSchema.parse(bad)).not.toThrow()
  })

  test('descends into an iteration subgraph and flags a misconfigured child', () => {
    const itemTrigger = {
      id: 'it',
      kind: 'trigger' as const,
      position: pos,
      label: 'Item',
      informUser: { mode: 'off' as const },
      config: { triggerKind: 'iteration_item' },
    }
    const iteration = {
      id: 'loop',
      kind: 'iteration' as const,
      position: pos,
      label: 'Loop',
      informUser: { mode: 'off' as const },
      config: {
        source: { kind: 'ref' as const, nodeId: 't', path: '' },
        concurrency: 1,
        stopOnError: false,
        itemExecution: 'durable' as const,
        itemTitle: '',
        // Child agent has no agent selected — an error that lives inside the loop.
        subgraph: graph(
          [itemTrigger, agent('child', ''), output('res')],
          [edge('it', 'child'), edge('child', 'res')],
        ),
      },
    }
    const g = graph(
      [trigger, iteration, output()],
      [edge('t', 'loop'), edge('loop', 'o')],
    )
    const issues = collectGraphIssues(g)
    expect(
      issues.some((i) => i.nodeId === 'child' && /No agent/.test(i.message)),
    ).toBe(true)
  })

  test('flags an "Inform user" note on a step inside a loop', () => {
    const itemTrigger = {
      id: 'it',
      kind: 'trigger' as const,
      position: pos,
      label: 'Item',
      informUser: { mode: 'off' as const },
      config: { triggerKind: 'iteration_item' },
    }
    const child = {
      ...agent('child', 'a1'),
      informUser: { mode: 'static' as const, note: 'Reading this one.' },
    }
    const iteration = {
      id: 'loop',
      kind: 'iteration' as const,
      position: pos,
      label: 'Loop',
      informUser: { mode: 'static' as const, note: 'Reading ${n}.' },
      config: {
        source: { kind: 'ref' as const, nodeId: 't', path: '' },
        concurrency: 1,
        stopOnError: false,
        itemExecution: 'inline' as const,
        itemTitle: '',
        maxItems: 10,
        subgraph: graph(
          [itemTrigger, child, output('res', 'child')],
          [edge('it', 'child'), edge('child', 'res')],
        ),
      },
    }
    const issues = collectGraphIssues(
      graph([trigger, iteration, output()], [edge('t', 'loop'), edge('loop', 'o')]),
    )
    // The child is flagged — nothing it reports can reach the user…
    expect(
      issues.some(
        (i) => i.nodeId === 'child' && /Inform user/.test(i.message),
      ),
    ).toBe(true)
    // …while the loop's OWN note is exactly where narration belongs.
    expect(
      issues.some((i) => i.nodeId === 'loop' && /Inform user/.test(i.message)),
    ).toBe(false)
  })

  // ── Iteration item execution ────────────────────────────────────────────────
  // The editor can see how much work ONE item does; only the author knows how
  // many items there will be. These warnings surface the half the editor knows.

  // Build an iteration whose subgraph holds `inner` between the Item bookend and
  // the subgraph Output, at a given item-execution setting.
  const loop = (
    itemExecution: 'inline' | 'durable',
    inner: WorkflowGraph['nodes'],
  ) => {
    const itemTrigger = {
      id: 'it',
      kind: 'trigger' as const,
      position: pos,
      label: 'Item',
      informUser: { mode: 'off' as const },
      config: { triggerKind: 'iteration_item' },
    }
    const last = inner[inner.length - 1]
    return {
      id: 'loop',
      kind: 'iteration' as const,
      position: pos,
      label: 'Loop',
      informUser: { mode: 'off' as const },
      config: {
        source: { kind: 'ref' as const, nodeId: 't', path: '' },
        concurrency: 1,
        stopOnError: false,
        itemExecution,
        itemTitle: '',
        // Bounded, so these fixtures raise only the execution-shape issue they
        // are about — the fan-out fence has its own tests below.
        maxItems: 10,
        subgraph: graph(
          [itemTrigger, ...inner, output('res', last.id)],
          [
            edge('it', inner[0].id),
            ...inner.slice(1).map((n, i) => edge(inner[i].id, n.id)),
            edge(last.id, 'res'),
          ],
        ),
      },
    }
  }

  const loopIssue = (node: WorkflowGraph['nodes'][number]) =>
    collectGraphIssues(
      graph([trigger, node, output('o', 'loop')], [
        edge('t', 'loop'),
        edge('loop', 'o'),
      ]),
    ).find((i) => i.nodeId === 'loop' && /item/i.test(i.message))

  test('warns when an inline item runs an agent', () => {
    const issue = loopIssue(loop('inline', [agent('a')]))
    expect(issue?.severity).toBe('warning')
    expect(issue?.message).toMatch(/runs an agent/)
    expect(issue?.message).toMatch(/Durable/)
  })

  test('warns when an inline item has more than three steps', () => {
    const issue = loopIssue(
      loop('inline', [tool('s1'), tool('s2'), tool('s3'), tool('s4')]),
    )
    expect(issue?.severity).toBe('warning')
    expect(issue?.message).toMatch(/4 steps/)
  })

  test('leaves a small inline item alone', () => {
    expect(loopIssue(loop('inline', [tool('s1'), tool('s2')]))).toBeUndefined()
  })

  test('warns when a trivial item pays for its own run', () => {
    const issue = loopIssue(loop('durable', [tool('s1')]))
    expect(issue?.severity).toBe('warning')
    expect(issue?.message).toMatch(/costs more/)
  })

  test('leaves a heavy durable item alone', () => {
    expect(loopIssue(loop('durable', [agent('a')]))).toBeUndefined()
  })

  // ── Iteration fan-out bound ─────────────────────────────────────────────────
  // Unlike the two above these are ERRORS, because how many items a runtime can
  // carry isn't a judgement call the author is better placed to make — and the
  // list length is data, so nothing at authoring time rules a huge one out.

  // Same fixture as `loop`, with `maxItems` under the author's control.
  const boundedLoop = (
    itemExecution: 'inline' | 'durable',
    maxItems: number | undefined,
  ) => {
    const node = loop(itemExecution, [tool('s1')])
    return {
      ...node,
      config: { ...node.config, maxItems },
    }
  }

  const boundIssue = (node: WorkflowGraph['nodes'][number]) =>
    collectGraphIssues(
      graph(
        [trigger, node, output('o', 'loop')],
        [edge('t', 'loop'), edge('loop', 'o')],
      ),
    ).find((i) => i.nodeId === 'loop' && /limit/i.test(i.message))

  test('errors when an iteration has no item limit', () => {
    const issue = boundIssue(boundedLoop('inline', undefined))
    expect(issue?.severity).toBe('error')
    expect(issue?.message).toMatch(/No item limit set/)
    // Names the ceiling, so the author has a number to reach for.
    expect(issue?.message).toContain(String(ITERATION_MAX_ITEMS_CEILING.inline))
  })

  test('errors when the limit is above the mode’s ceiling', () => {
    const issue = boundIssue(
      boundedLoop('inline', ITERATION_MAX_ITEMS_CEILING.inline + 1),
    )
    expect(issue?.severity).toBe('error')
    expect(issue?.message).toMatch(/above the/)
    // Inline's ceiling is the low one, so the way out is named.
    expect(issue?.message).toMatch(/Durable/)
  })

  test('the ceiling follows the item execution mode', () => {
    // A bound that is too wide for inline is fine once each item owns a run.
    const overInline = ITERATION_MAX_ITEMS_CEILING.inline + 1
    expect(boundIssue(boundedLoop('inline', overInline))?.severity).toBe(
      'error',
    )
    expect(boundIssue(boundedLoop('durable', overInline))).toBeUndefined()
  })

  test('leaves a bounded iteration alone', () => {
    expect(boundIssue(boundedLoop('inline', 25))).toBeUndefined()
  })
})
