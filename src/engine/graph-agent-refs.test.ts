import { describe, expect, test } from 'bun:test'

import type { WorkflowGraph, WorkflowNode } from './graph'
import { collectAgentRefIssues, type AgentRefIndex } from './graph-agent-refs'

const pos = { x: 0, y: 0 }

// The failure this lint exists for: a populated-but-dangling `agentId` lints
// clean, publishes clean, and then fails inside `resolveRunManifest` — which
// runs BEFORE the run is marked running, so the trace has no steps and no node
// to blame. Every case below is a graph that used to pass validation.

function agentNode(
  id: string,
  agentId: string,
  version: number | null = null,
): WorkflowNode {
  return {
    id,
    kind: 'agent',
    position: pos,
    label: id,
    informUser: { mode: 'off' },
    config: { agentId, version, inputs: {} },
  }
}

/** An iteration node wrapping a per-item subgraph, to prove the walk recurses. */
function iterationNode(id: string, ...inner: WorkflowNode[]): WorkflowNode {
  return {
    id,
    kind: 'iteration',
    position: pos,
    label: id,
    informUser: { mode: 'off' },
    config: {
      source: { kind: 'ref', nodeId: 'up', path: '' },
      subgraph: { version: 1, nodes: inner, edges: [] },
      concurrency: 1,
      stopOnError: true,
      itemExecution: 'inline',
      itemTitle: 'item',
    },
  }
}

function graph(...nodes: WorkflowNode[]): WorkflowGraph {
  return { version: 1, nodes, edges: [] }
}

function index(): AgentRefIndex {
  return new Map([
    [
      'live',
      {
        name: 'Triage',
        archived: false,
        latestVersionNumber: 3,
        versionNumbers: new Set([1, 3]),
      },
    ],
    [
      'unpublished',
      {
        name: 'Half-built',
        archived: false,
        latestVersionNumber: null,
        versionNumbers: new Set<number>(),
      },
    ],
    [
      'gone',
      {
        name: 'Retired',
        archived: true,
        latestVersionNumber: 2,
        versionNumbers: new Set([1, 2]),
      },
    ],
  ])
}

describe('collectAgentRefIssues', () => {
  test('a node pointing at a published agent is clean', () => {
    expect(collectAgentRefIssues(graph(agentNode('a', 'live')), index())).toEqual(
      [],
    )
  })

  test('an id that names no agent is an error, attributed to the node', () => {
    const issues = collectAgentRefIssues(
      graph(agentNode('a', '00000000-0000-4000-8000-000000000000')),
      index(),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]?.severity).toBe('error')
    expect(issues[0]?.nodeId).toBe('a')
    expect(issues[0]?.message).toContain(
      '00000000-0000-4000-8000-000000000000',
    )
  })

  test('an empty agentId is left to the structural lint', () => {
    // `collectGraphIssues` already says "No agent selected"; two lines for one
    // unconfigured node is noise.
    expect(collectAgentRefIssues(graph(agentNode('a', '')), index())).toEqual([])
  })

  test('an agent that was never published is an error', () => {
    const issues = collectAgentRefIssues(
      graph(agentNode('a', 'unpublished')),
      index(),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]?.severity).toBe('error')
    expect(issues[0]?.message).toContain('never been published')
  })

  test('a pin on a version that was never published is an error', () => {
    const issues = collectAgentRefIssues(
      graph(agentNode('a', 'live', 2)),
      index(),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]?.severity).toBe('error')
    expect(issues[0]?.message).toContain('version 2')
    // Says what the newest one is, so the fix needs no second lookup.
    expect(issues[0]?.message).toContain('latest is 3')
  })

  test('a pin on a real version is clean', () => {
    expect(
      collectAgentRefIssues(graph(agentNode('a', 'live', 1)), index()),
    ).toEqual([])
  })

  test('without a version list, a pin above latest is still caught', () => {
    const sparse: AgentRefIndex = new Map([
      ['live', { name: 'Triage', latestVersionNumber: 3 }],
    ])
    expect(
      collectAgentRefIssues(graph(agentNode('a', 'live', 9)), sparse),
    ).toHaveLength(1)
    // …and a pin at or below latest is assumed real rather than invented as a
    // failure the caller cannot see.
    expect(
      collectAgentRefIssues(graph(agentNode('a', 'live', 2)), sparse),
    ).toEqual([])
  })

  test('an archived agent is a warning, not an error — it still runs', () => {
    const issues = collectAgentRefIssues(graph(agentNode('a', 'gone')), index())
    expect(issues).toHaveLength(1)
    expect(issues[0]?.severity).toBe('warning')
    expect(issues[0]?.message).toContain('archived')
  })

  test('a node inside an iteration subgraph is checked too', () => {
    const issues = collectAgentRefIssues(
      graph(iterationNode('loop', agentNode('inner', 'unpublished'))),
      index(),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]?.nodeId).toBe('inner')
  })

  test('each bad node reports once, and good ones stay silent', () => {
    const issues = collectAgentRefIssues(
      graph(
        agentNode('ok', 'live'),
        agentNode('bad', 'nope'),
        agentNode('stale', 'live', 2),
      ),
      index(),
    )
    expect(issues.map((i) => i.nodeId).sort()).toEqual(['bad', 'stale'])
  })
})
