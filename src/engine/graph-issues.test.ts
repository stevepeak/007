import { describe, expect, test } from 'bun:test'

import { collectGraphIssues } from './graph-issues'
import { workflowGraphShapeSchema, type WorkflowGraph } from './graph'

const pos = { x: 0, y: 0 }
const trigger = {
  id: 't',
  kind: 'trigger' as const,
  position: pos,
  label: 'Start',
  config: { triggerKind: 'chat_message' },
}
const output = (id = 'o') => ({
  id,
  kind: 'output' as const,
  position: pos,
  label: id,
  config: {},
})
const agent = (id: string, agentId = 'a1') => ({
  id,
  kind: 'agent' as const,
  position: pos,
  label: id,
  config: { agentId, inputs: {} },
})
const branch = (id: string) => ({
  id,
  kind: 'branch' as const,
  position: pos,
  label: id,
  config: { operator: 'is_not_empty' as const },
})
const race = (id: string) => ({
  id,
  kind: 'race' as const,
  position: pos,
  label: id,
  config: {},
})
const edge = (
  source: string,
  target: string,
  condition: 'yes' | 'no' | null = null,
) => ({ id: `${source}->${target}`, source, target, condition })

function graph(
  nodes: WorkflowGraph['nodes'],
  edges: WorkflowGraph['edges'],
): WorkflowGraph {
  return { version: 1, nodes, edges }
}

describe('collectGraphIssues', () => {
  test('a clean linear graph has no issues', () => {
    const g = graph(
      [trigger, agent('x'), output()],
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
      config: { triggerKind: 'iteration_item' },
    }
    const iteration = {
      id: 'loop',
      kind: 'iteration' as const,
      position: pos,
      label: 'Loop',
      config: {
        source: { kind: 'ref' as const, nodeId: 't', path: '' },
        concurrency: 1,
        stopOnError: false,
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
})
