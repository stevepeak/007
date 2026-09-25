import { describe, expect, test } from 'bun:test'

import type { WorkflowGraph, WorkflowNode } from '../engine/graph'
import type {
  WfDataClient,
  WfGraphValidation,
  WfWorkflowDetail,
} from '../server/protocol'

import type { WfMcpTool } from './tools'
import {
  applyPatchOp,
  graphDelta,
  workflowReadTools,
  workflowWriteTools,
} from './tools-workflows'

/**
 * What is worth pinning here is the two gates and the receipt: a patch that
 * fails writes nothing; a publish is refused on a stale base or a lint error;
 * and every write says what now differs from what is live.
 */

function toolNamed(name: string): WfMcpTool {
  const found = [...workflowReadTools(), ...workflowWriteTools()].find(
    (t) => t.name === name,
  )
  if (!found) throw new Error(`no such tool: ${name}`)
  return found
}

function stubClient(partial: Partial<WfDataClient>): WfDataClient {
  return partial as WfDataClient
}

const pos = { x: 0, y: 0 }
const trigger: WorkflowNode = {
  id: 't',
  kind: 'trigger',
  position: pos,
  label: 'Chat message',
  informUser: { mode: 'off' },
  config: { triggerKind: 'chat_message' },
}
// The ART-146 node as published in v25: a renamed field and a string boolean.
const escalate: WorkflowNode = {
  id: 'esc',
  kind: 'tool',
  position: pos,
  label: 'Escalate',
  informUser: { mode: 'off' },
  config: {
    toolId: 'escalate_chat',
    args: {
      note: { kind: 'ref', nodeId: 't', path: 'userText' },
      lock: { kind: 'literal', value: 'false' },
    },
  },
}
const output: WorkflowNode = {
  id: 'o',
  kind: 'output',
  position: pos,
  label: 'Response',
  informUser: { mode: 'off' },
  config: { source: { kind: 'ref', nodeId: 'esc', path: '' } },
}
const published: WorkflowGraph = {
  version: 1,
  nodes: [trigger, escalate, output],
  edges: [
    { id: 'e1', source: 't', target: 'esc', condition: null },
    { id: 'e2', source: 'esc', target: 'o', condition: null },
  ],
}

function detail(over: Partial<WfWorkflowDetail> = {}): WfWorkflowDetail {
  return {
    workflow: {
      id: 'w1',
      name: 'Legal chat',
      description: null,
      createdAt: 0,
      archived: false,
    },
    draft: null,
    currentVersion: { id: 'v28', versionNumber: 28, graph: published },
    ...over,
  }
}

const clean: WfGraphValidation = {
  source: 'supplied',
  versionNumber: null,
  issues: [],
  errors: 0,
  warnings: 0,
}
const broken: WfGraphValidation = {
  ...clean,
  issues: [
    {
      nodeId: 'esc',
      nodeLabel: 'Escalate',
      severity: 'error',
      message:
        'Argument "lock" of escalate_chat expects boolean or null but the literal is string "false".',
    },
  ],
  errors: 1,
}

describe('applyPatchOp', () => {
  test('set_tool_arg replaces a binding and reports what changed', () => {
    const g = structuredClone(published)
    const r = applyPatchOp(g, {
      op: 'set_tool_arg',
      nodeId: 'esc',
      arg: 'lock',
      binding: { kind: 'literal', value: false },
    })
    const node = g.nodes[1] as Extract<WorkflowNode, { kind: 'tool' }>
    expect(node.config.args.lock).toEqual({ kind: 'literal', value: false })
    expect(r.summary).toContain('lock changed → literal false')
  })

  test('set_tool_arg rejects a malformed binding and a ref to nowhere', () => {
    const g = structuredClone(published)
    expect(() => {
      return applyPatchOp(g, {
        op: 'set_tool_arg',
        nodeId: 'esc',
        arg: 'lock',
        binding: { value: false },
      })
    }).toThrow('must be { kind: "literal", value }')
    expect(() => {
      return applyPatchOp(g, {
        op: 'set_tool_arg',
        nodeId: 'esc',
        arg: 'lock',
        binding: { kind: 'ref', nodeId: 'ghost', path: '' },
      })
    }).toThrow('missing node ghost')
  })

  test('remove_tool_arg names the args that exist when the target does not', () => {
    const g = structuredClone(published)
    expect(() => {
      return applyPatchOp(g, {
        op: 'remove_tool_arg',
        nodeId: 'esc',
        arg: 'nope',
      })
    }).toThrow('has: note, lock')
    applyPatchOp(g, { op: 'remove_tool_arg', nodeId: 'esc', arg: 'note' })
    const node = g.nodes[1] as Extract<WorkflowNode, { kind: 'tool' }>
    expect(Object.keys(node.config.args)).toEqual(['lock'])
  })

  test('remove_node takes its edges with it', () => {
    const g = structuredClone(published)
    const r = applyPatchOp(g, { op: 'remove_node', nodeId: 'esc' })
    expect(g.nodes.map((n) => n.id)).toEqual(['t', 'o'])
    expect(g.edges).toEqual([])
    expect(r.summary).toContain('2 connected edges')
  })

  test('add_edge refuses a duplicate; remove_edge works by id or endpoints', () => {
    const g = structuredClone(published)
    expect(() => {
      return applyPatchOp(g, { op: 'add_edge', source: 't', target: 'esc' })
    }).toThrow('already exists (e1)')
    applyPatchOp(g, {
      op: 'add_edge',
      source: 't',
      target: 'o',
      condition: 'yes',
    })
    expect(g.edges).toHaveLength(3)
    applyPatchOp(g, { op: 'remove_edge', edgeId: 'e1' })
    applyPatchOp(g, { op: 'remove_edge', source: 't', target: 'o' })
    expect(g.edges.map((e) => e.id)).toEqual(['e2'])
  })
})

describe('graphDelta', () => {
  test('ignores a node that only moved', () => {
    const moved: WorkflowGraph = {
      ...published,
      nodes: published.nodes.map((n) => ({ ...n, position: { x: 9, y: 9 } })),
    }
    const d = graphDelta(published, moved)
    expect(d).toEqual({
      nodesAdded: [],
      nodesRemoved: [],
      nodesChanged: [],
      edgesAdded: 0,
      edgesRemoved: 0,
    })
  })
})

describe('patch_workflow_draft', () => {
  const tool = toolNamed('patch_workflow_draft')

  test('applies ops to the published graph when there is no draft, writes the draft, lints it', async () => {
    const writes: unknown[] = []
    const client = stubClient({
      getWorkflow: async () => detail(),
      updateDraft: async (input) => {
        writes.push(input)
      },
      validateGraph: async () => clean,
    })
    const result = (await tool.run(client, {
      workflowId: 'w1',
      ops: [
        {
          op: 'set_tool_arg',
          nodeId: 'esc',
          arg: 'lock',
          binding: { kind: 'literal', value: false },
        },
        { op: 'remove_tool_arg', nodeId: 'esc', arg: 'note' },
      ],
    })) as {
      ok: boolean
      startedFrom: string
      applied: { summary: string }[]
      draftDiffersFromPublished: { nodesChanged: string[] }
      next: string
    }
    expect(result.ok).toBe(true)
    expect(result.startedFrom).toBe('published')
    expect(result.applied).toHaveLength(2)
    expect(writes).toHaveLength(1)
    const written = (writes[0] as { graph: WorkflowGraph }).graph
    const node = written.nodes[1] as Extract<WorkflowNode, { kind: 'tool' }>
    expect(node.config.args).toEqual({
      lock: { kind: 'literal', value: false },
    })
    expect(result.draftDiffersFromPublished.nodesChanged).toEqual([
      'Escalate (esc)',
    ])
    expect(result.next).toContain('baseVersionNumber: 28')
  })

  test('one bad op writes nothing', async () => {
    const writes: unknown[] = []
    const client = stubClient({
      getWorkflow: async () => detail(),
      updateDraft: async (input) => {
        writes.push(input)
      },
      validateGraph: async () => clean,
    })
    const result = (await tool.run(client, {
      workflowId: 'w1',
      ops: [
        { op: 'set_node_label', nodeId: 'esc', label: 'Escalate (No Lock)' },
        {
          op: 'set_tool_arg',
          nodeId: 'ghost',
          arg: 'lock',
          binding: { kind: 'literal', value: false },
        },
      ],
    })) as { error: string; applied: unknown[] }
    expect(result.error).toContain('ops[1] failed: set_tool_arg: no node ghost')
    expect(result.error).toContain('Nothing was written')
    expect(result.applied).toHaveLength(1)
    expect(writes).toEqual([])
  })

  test('a merge that breaks the node shape writes nothing', async () => {
    const writes: unknown[] = []
    const client = stubClient({
      getWorkflow: async () => detail(),
      updateDraft: async (input) => {
        writes.push(input)
      },
      validateGraph: async () => clean,
    })
    const result = (await tool.run(client, {
      workflowId: 'w1',
      ops: [{ op: 'merge_node_config', nodeId: 'esc', config: { toolId: 42 } }],
    })) as { error: string }
    expect(result.error).toContain('not well-formed')
    expect(writes).toEqual([])
  })

  test('starts from the draft when one exists', async () => {
    const draftGraph = structuredClone(published)
    draftGraph.nodes[1].label = 'Escalate (draft)'
    const writes: unknown[] = []
    const client = stubClient({
      getWorkflow: async () => detail({ draft: { graph: draftGraph } }),
      updateDraft: async (input) => {
        writes.push(input)
      },
      validateGraph: async () => broken,
    })
    const result = (await tool.run(client, {
      workflowId: 'w1',
      ops: [{ op: 'remove_tool_arg', nodeId: 'esc', arg: 'note' }],
    })) as { startedFrom: string; validation: { errors: number }; note: string }
    expect(result.startedFrom).toBe('draft')
    const written = (writes[0] as { graph: WorkflowGraph }).graph
    expect(written.nodes[1].label).toBe('Escalate (draft)')
    expect(result.validation.errors).toBe(1)
    expect(result.note).toContain('cannot be published until')
  })
})

describe('publish_workflow', () => {
  const tool = toolNamed('publish_workflow')
  const draftGraph = (() => {
    const g = structuredClone(published)
    applyPatchOp(g, {
      op: 'set_tool_arg',
      nodeId: 'esc',
      arg: 'lock',
      binding: { kind: 'literal', value: false },
    })
    return g
  })()

  function client(over: Partial<WfDataClient> & { saves?: unknown[] } = {}) {
    const saves = over.saves ?? []
    return stubClient({
      getWorkflow: async () => detail({ draft: { graph: draftGraph } }),
      validateGraph: async () => clean,
      summarizeChanges: async () => ({
        short: 'Lock passed as a boolean',
        long: 'The Escalate node now binds `lock` as a real boolean.',
      }),
      saveVersion: async (input) => {
        saves.push(input)
        return { versionId: 'v29', versionNumber: 29 }
      },
      ...over,
    })
  }

  test('publishes the draft with the note, and reports the delta', async () => {
    const saves: unknown[] = []
    const result = (await tool.run(client({ saves }), {
      workflowId: 'w1',
      changeNote: 'ART-146: lock as a real boolean',
      baseVersionNumber: 28,
    })) as {
      ok: boolean
      published: { versionNumber: number }
      changed: { nodesChanged: string[] }
    }
    expect(result.ok).toBe(true)
    expect(result.published.versionNumber).toBe(29)
    expect(result.changed.nodesChanged).toEqual(['Escalate (esc)'])
    expect(saves).toEqual([
      {
        workflowId: 'w1',
        graph: draftGraph,
        changeNote: 'ART-146: lock as a real boolean',
        // Generated inline and handed to `saveVersion`. Left to the server's
        // async fallback it needs the host to have wired a background task, and
        // on a host that hasn't, `aiSummaryShort` stays null forever — so an
        // MCP-published version was permanently unlabelled in the history and in
        // the drift report.
        aiSummary: {
          short: 'Lock passed as a boolean',
          long: 'The Escalate node now binds `lock` as a real boolean.',
        },
      },
    ])
  })

  test('skips the summary when asked, without blocking the publish', async () => {
    const saves: unknown[] = []
    const result = (await tool.run(client({ saves }), {
      workflowId: 'w1',
      changeNote: 'no summary please',
      baseVersionNumber: 28,
      summarize: false,
    })) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect((saves[0] as { aiSummary?: unknown }).aiSummary).toBeUndefined()
  })

  // A published version with no summary beats a refused publish: the summary is
  // labelling, and the graph is the thing that had to ship.
  test('publishes anyway when the summary call fails', async () => {
    const saves: unknown[] = []
    const result = (await tool.run(
      client({
        saves,
        summarizeChanges: () => Promise.reject(new Error('judge model down')),
      }),
      {
        workflowId: 'w1',
        changeNote: 'summary unavailable',
        baseVersionNumber: 28,
      },
    )) as { ok: boolean; published: { versionNumber: number } }
    expect(result.ok).toBe(true)
    expect(result.published.versionNumber).toBe(29)
    expect((saves[0] as { aiSummary?: unknown }).aiSummary).toBeUndefined()
  })

  // The v28 incident: a publish from a draft that predated someone else's fix.
  test('refuses a stale base version', async () => {
    const saves: unknown[] = []
    const result = (await tool.run(client({ saves }), {
      workflowId: 'w1',
      changeNote: 'x',
      baseVersionNumber: 27,
    })) as { error: string }
    expect(result.error).toContain('v28 is live but you based this on v27')
    expect(saves).toEqual([])
  })

  test('refuses while the lint has errors', async () => {
    const saves: unknown[] = []
    const result = (await tool.run(
      client({ saves, validateGraph: async () => broken }),
      { workflowId: 'w1', changeNote: 'x', baseVersionNumber: 28 },
    )) as { error: string; validation: { issues: string[] } }
    expect(result.error).toContain('has 1 error')
    expect(result.validation.issues[0]).toContain('[error] Escalate (esc)')
    expect(saves).toEqual([])
  })

  test('refuses without a change note, without a draft, and with an unchanged draft', async () => {
    const saves: unknown[] = []
    const noNote = (await tool.run(client({ saves }), {
      workflowId: 'w1',
      baseVersionNumber: 28,
    })) as { error: string }
    expect(noNote.error).toContain('changeNote')

    const noDraft = (await tool.run(
      client({ saves, getWorkflow: async () => detail() }),
      { workflowId: 'w1', changeNote: 'x', baseVersionNumber: 28 },
    )) as { error: string }
    expect(noDraft.error).toContain('no draft to publish')

    const same = (await tool.run(
      client({
        saves,
        getWorkflow: async () => detail({ draft: { graph: published } }),
      }),
      { workflowId: 'w1', changeNote: 'x', baseVersionNumber: 28 },
    )) as { error: string }
    expect(same.error).toContain('identical to v28')
    expect(saves).toEqual([])
  })
})

describe('discard_workflow_draft', () => {
  test('says what was lost', async () => {
    const draftGraph = structuredClone(published)
    applyPatchOp(draftGraph, { op: 'remove_node', nodeId: 'esc' })
    const calls: unknown[] = []
    const client = stubClient({
      getWorkflow: async () => detail({ draft: { graph: draftGraph } }),
      discardDraft: async (input) => {
        calls.push(input)
      },
    })
    const result = (await toolNamed('discard_workflow_draft').run(client, {
      workflowId: 'w1',
    })) as { discarded: { nodesRemoved: string[] }; note: string }
    expect(calls).toEqual([{ workflowId: 'w1' }])
    expect(result.discarded.nodesRemoved).toEqual(['Escalate (esc)'])
    expect(result.note).toContain('those edits are gone')
  })
})

describe('validate_workflow_graph', () => {
  test('needs a target and passes it through', async () => {
    const tool = toolNamed('validate_workflow_graph')
    const client = stubClient({ validateGraph: async () => broken })
    expect(await tool.run(client, {})).toEqual({
      error: 'Pass one of workflowId, versionId or graph.',
    })
    const result = (await tool.run(client, { workflowId: 'w1' })) as {
      errors: number
      verdict: string
    }
    expect(result.errors).toBe(1)
    expect(result.verdict).toContain('Cannot be published')
  })
})

describe('gating', () => {
  test('reads are read-only, writes are not', () => {
    expect(workflowReadTools().every((t) => t.readOnly)).toBe(true)
    expect(workflowWriteTools().every((t) => !t.readOnly)).toBe(true)
  })
})

describe('patch ops that reach the fields merge_node_config cannot', () => {
  // `informUser` and `execution` are SIBLINGS of `config` on a node, so
  // merge_node_config could never touch them — which left every customer-visible
  // progress note and every retry policy unauthorable from here.
  test('set_inform_user writes the progress note the customer sees', () => {
    const g = structuredClone(published)
    const applied = applyPatchOp(g, {
      op: 'set_inform_user',
      nodeId: 'esc',
      informUser: { mode: 'static', note: 'Escalating to a lawyer…' },
    })
    expect(g.nodes[1].informUser).toEqual({
      mode: 'static',
      note: 'Escalating to a lawyer…',
    })
    expect(applied.summary).toContain('Escalating to a lawyer')
  })

  test('set_inform_user refuses dynamic on a non-agent node', () => {
    const g = structuredClone(published)
    expect(() => { return applyPatchOp(g, {
        op: 'set_inform_user',
        nodeId: 'esc',
        informUser: { mode: 'dynamic', reasoning: true, tools: true },
      }) },
    ).toThrow(/only applies to agent nodes/)
    // Nothing partially applied.
    expect(g.nodes[1].informUser).toEqual({ mode: 'off' })
  })

  test('set_node_execution writes a retry policy, and {} clears it', () => {
    const g = structuredClone(published)
    applyPatchOp(g, {
      op: 'set_node_execution',
      nodeId: 'esc',
      execution: { timeoutMs: 30_000, retries: { limit: 2 } },
    })
    expect(g.nodes[1].execution).toEqual({
      timeoutMs: 30_000,
      retries: { limit: 2 },
    })
    const cleared = applyPatchOp(g, {
      op: 'set_node_execution',
      nodeId: 'esc',
      execution: {},
    })
    // Absent, not an empty object: absent is what "use the engine default"
    // looks like on an optional field.
    expect(g.nodes[1].execution).toBeUndefined()
    expect(cleared.summary).toContain('cleared')
  })
})

describe('add_node', () => {
  test('adds a node seeded from the engine’s own table, with no edges', () => {
    const g = structuredClone(published)
    const before = g.nodes.length
    const applied = applyPatchOp(g, { op: 'add_node', kind: 'agent' })
    expect(g.nodes).toHaveLength(before + 1)
    const added = g.nodes.at(-1)!
    expect(added.kind).toBe('agent')
    // The deliberately-incomplete seed: an agent with no agentId lints as "not
    // configured yet" rather than looking finished.
    expect((added.config as { agentId: string }).agentId).toBe('')
    expect(g.edges.filter((e) => e.source === added.id || e.target === added.id)).toEqual([])
    expect(applied.nodeId).toBe(added.id)
    // Placed below everything else, so it isn't invisible under another node.
    expect(added.position.y).toBeGreaterThan(0)
  })

  test('takes a label when given one', () => {
    const g = structuredClone(published)
    applyPatchOp(g, { op: 'add_node', kind: 'agent', label: 'Draft the reply' })
    expect(g.nodes.at(-1)!.label).toBe('Draft the reply')
  })

  // The bookends are seeded with the graph itself, so offering to add one would
  // produce a second trigger and an invalid graph.
  test('refuses a bookend kind, and names what it can add', () => {
    const g = structuredClone(published)
    expect(() => applyPatchOp(g, { op: 'add_node', kind: 'trigger' })).toThrow(
      /bookend/,
    )
    expect(() => applyPatchOp(g, { op: 'add_node', kind: 'nonsense' })).toThrow(
      /must be one of/,
    )
    expect(g.nodes).toHaveLength(3)
  })
})

describe('ops reach inside an iteration subgraph', () => {
  /** A graph whose iteration holds one tool node. */
  function withIteration(): WorkflowGraph {
    const inner: WorkflowNode = {
      id: 'inner',
      kind: 'tool',
      position: pos,
      label: 'Per item',
      informUser: { mode: 'off' },
      config: { toolId: 'summarize', args: {} },
    }
    const iteration: WorkflowNode = {
      id: 'iter',
      kind: 'iteration',
      position: pos,
      label: 'For each',
      informUser: { mode: 'off' },
      config: {
        source: { kind: 'ref', nodeId: 't', path: '' },
        maxItems: 10,
        itemExecution: 'inline',
        subgraph: { version: 1, nodes: [inner], edges: [] },
      } as never,
    }
    return {
      version: 1,
      nodes: [trigger, iteration, output],
      edges: [{ id: 'e1', source: 't', target: 'iter', condition: null }],
    }
  }

  function subgraphOf(g: WorkflowGraph): WorkflowGraph {
    const iter = g.nodes.find((n) => n.id === 'iter')!
    return (iter.config as { subgraph: WorkflowGraph }).subgraph
  }

  // An inner node could already be configured and relabelled but not deleted or
  // rewired — half-reachable, which reads as supported and fails on the second
  // call.
  test('remove_node deletes an inner node and its edges', () => {
    const g = withIteration()
    const second: WorkflowNode = {
      id: 'inner2',
      kind: 'tool',
      position: pos,
      label: 'Then',
      informUser: { mode: 'off' },
      config: { toolId: 'x', args: {} },
    }
    subgraphOf(g).nodes.push(second)
    subgraphOf(g).edges.push({
      id: 'ie1',
      source: 'inner',
      target: 'inner2',
      condition: null,
    })

    const applied = applyPatchOp(g, { op: 'remove_node', nodeId: 'inner2' })
    expect(subgraphOf(g).nodes.map((n) => n.id)).toEqual(['inner'])
    expect(subgraphOf(g).edges).toEqual([])
    expect(applied.summary).toContain('iteration subgraph')
    // The top level is untouched.
    expect(g.nodes).toHaveLength(3)
  })

  test('add_edge wires two inner nodes, on the subgraph that owns them', () => {
    const g = withIteration()
    subgraphOf(g).nodes.push({
      id: 'inner2',
      kind: 'tool',
      position: pos,
      label: 'Then',
      informUser: { mode: 'off' },
      config: { toolId: 'x', args: {} },
    })
    applyPatchOp(g, { op: 'add_edge', source: 'inner', target: 'inner2' })
    expect(subgraphOf(g).edges).toHaveLength(1)
    // NOT on the top-level graph.
    expect(g.edges).toHaveLength(1)
  })

  // An iteration subgraph is a closed scope — the engine runs it once per item —
  // so a cross-boundary edge has no meaning and would be dropped on validation.
  test('add_edge refuses to cross the subgraph boundary', () => {
    const g = withIteration()
    expect(() => { return applyPatchOp(g, { op: 'add_edge', source: 't', target: 'inner' }) },
    ).toThrow(/different graphs/)
    expect(subgraphOf(g).edges).toEqual([])
  })

  test('remove_edge finds an edge inside a subgraph by id', () => {
    const g = withIteration()
    subgraphOf(g).edges.push({
      id: 'ie1',
      source: 'inner',
      target: 'inner',
      condition: null,
    })
    applyPatchOp(g, { op: 'remove_edge', edgeId: 'ie1' })
    expect(subgraphOf(g).edges).toEqual([])
  })

  test('add_node can target a subgraph by its iteration node', () => {
    const g = withIteration()
    applyPatchOp(g, { op: 'add_node', kind: 'agent', subgraphOf: 'iter' })
    expect(subgraphOf(g).nodes).toHaveLength(2)
    expect(g.nodes).toHaveLength(3)
  })

  test('add_node refuses a subgraphOf that is not an iteration node', () => {
    const g = withIteration()
    expect(() => { return applyPatchOp(g, { op: 'add_node', kind: 'agent', subgraphOf: 't' }) },
    ).toThrow(/must name an iteration node/)
  })
})

describe('update_workflow_draft — fromVersion', () => {
  const tool = toolNamed('update_workflow_draft')

  // Rolling back by hand means get_workflow_version then sending the graph back —
  // the whole-graph resend this tool's own doc warns about. Which made rollback
  // riskier from here than from the console.
  test('resets the draft to a published version, read server-side', async () => {
    const writes: { graph: WorkflowGraph }[] = []
    const old = structuredClone(published)
    old.nodes[1].label = 'Escalate (v20)'
    const client = stubClient({
      getWorkflow: async () => detail({ draft: { graph: published } }),
      listVersions: async () => { return [
          { id: 'v20', versionNumber: 20 },
          { id: 'v28', versionNumber: 28 },
        ] as never },
      getVersion: async () => ({ graph: old }) as never,
      updateDraft: async (input) => {
        writes.push(input)
      },
      validateGraph: async () => clean,
    })
    const result = (await tool.run(client, {
      workflowId: 'w1',
      fromVersion: 20,
    })) as { revertedTo: number; note: string }
    expect(result.revertedTo).toBe(20)
    expect(writes[0]?.graph.nodes[1].label).toBe('Escalate (v20)')
    // The publish gate is unchanged: baseVersionNumber is still what is LIVE.
    expect(result.note).toContain('v28')
  })

  test('names the versions that exist when the number is wrong', async () => {
    const client = stubClient({
      getWorkflow: async () => detail(),
      listVersions: async () => [{ id: 'v28', versionNumber: 28 }] as never,
    })
    const result = (await tool.run(client, {
      workflowId: 'w1',
      fromVersion: 5,
    })) as { error: string }
    expect(result.error).toContain('no published version 5')
    expect(result.error).toContain('28')
  })

  test('refuses graph and fromVersion together', async () => {
    const result = (await tool.run(stubClient({}), {
      workflowId: 'w1',
      graph: published,
      fromVersion: 20,
    })) as { error: string }
    expect(result.error).toContain('not both')
  })
})

describe('create_workflow', () => {
  const tool = toolNamed('create_workflow')

  function client(capture: { created?: Record<string, unknown> }, events: unknown[] = []) {
    return stubClient({
      listTriggerEvents: async () => events as never,
      createWorkflow: async (input) => {
        capture.created = input
        return { workflowId: 'w9', versionId: 'v1' }
      },
      getWorkflow: async () => detail({ workflow: { id: 'w9', name: 'New', description: null, createdAt: 0, archived: false } }),
    })
  }

  test('seeds a manual workflow that already validates and can run', async () => {
    const capture: { created?: Record<string, unknown> } = {}
    const result = (await tool.run(client(capture), { name: 'Intake' })) as {
      workflowId: string
      nodes: { trigger: string; output: string }
      next: string
    }
    expect(result.workflowId).toBe('w9')
    const graph = capture.created?.graph as WorkflowGraph
    // The minimal valid graph: a trigger wired straight to an Output.
    expect(graph.nodes.map((n) => n.kind)).toEqual(['trigger', 'output'])
    expect(graph.edges).toHaveLength(1)
    expect(result.nodes.trigger).toBeTruthy()
    expect(result.next).toContain('add_node')
  })

  test('requires cron for a periodic workflow, and warns that it starts firing', async () => {
    const capture: { created?: Record<string, unknown> } = {}
    const missing = (await tool.run(client(capture), {
      name: 'Nightly',
      trigger: 'periodic',
    })) as { error: string }
    expect(missing.error).toContain('`cron`')
    expect(capture.created).toBeUndefined()

    const ok = (await tool.run(client(capture), {
      name: 'Nightly',
      trigger: 'periodic',
      cron: '0 2 * * *',
    })) as { warning: string }
    // v1 is published, so it is live immediately — and all it does is pass the
    // trigger through.
    expect(ok.warning).toContain('0 2 * * *')
  })

  // `triggerKind` is a plain string resolved only at execution time, so an
  // unknown kind stores happily and produces a workflow that never fires.
  test('refuses an event kind the host does not declare', async () => {
    const capture: { created?: Record<string, unknown> } = {}
    const result = (await tool.run(
      client(capture, [{ kind: 'chat_message', description: 'A chat message', fields: [] }]),
      { name: 'On upload', trigger: 'document_uploaded' },
    )) as { error: string }
    expect(result.error).toContain('could never fire')
    expect(result.error).toContain('chat_message')
    expect(capture.created).toBeUndefined()
  })

  test('labels the trigger node with the event’s description, not its kind', async () => {
    const capture: { created?: Record<string, unknown> } = {}
    await tool.run(
      client(capture, [{ kind: 'chat_message', description: 'A chat message arrives', fields: [] }]),
      { name: 'Reply', trigger: 'chat_message' },
    )
    const graph = capture.created?.graph as WorkflowGraph
    expect(graph.nodes[0].label).toBe('A chat message arrives')
    expect((graph.nodes[0].config as { triggerKind: string }).triggerKind).toBe(
      'chat_message',
    )
  })
})

describe('update_workflow', () => {
  const tool = toolNamed('update_workflow')

  test('archiving reports that the workflow stops firing', async () => {
    let seen: unknown
    const client = stubClient({
      getWorkflow: async () => detail(),
      updateWorkflow: async (input) => {
        seen = input
      },
    })
    const result = (await tool.run(client, {
      workflowId: 'w1',
      archived: true,
    })) as { before: { archived: boolean }; note: string }
    expect(seen).toEqual({ workflowId: 'w1', name: undefined, archived: true })
    expect(result.before.archived).toBe(false)
    // Retiring, not deleting — and it names the trigger it stops firing on.
    expect(result.note).toContain('chat_message')
    expect(result.note).toContain('archived: false')
  })

  test('refuses a call that would change nothing', async () => {
    const result = (await tool.run(stubClient({}), { workflowId: 'w1' })) as {
      error: string
    }
    expect(result.error).toContain('nothing else this tool changes')
  })
})

describe('list_trigger_events', () => {
  const tool = toolNamed('list_trigger_events')

  test('names the two built-ins alongside the host’s events', async () => {
    const client = stubClient({
      listTriggerEvents: async () => { return [
          {
            kind: 'chat_message',
            description: 'A chat message arrives',
            fields: [{ name: 'text', type: 'string', optional: false }],
          },
        ] as never },
    })
    const result = (await tool.run(client, {})) as {
      builtIn: { kind: string }[]
      events: { kind: string }[]
    }
    // manual and periodic are always available and are not host-declared.
    expect(result.builtIn.map((b) => b.kind)).toEqual(['manual', 'periodic'])
    expect(result.events[0]?.kind).toBe('chat_message')
  })

  test('says so when the host declares no events at all', async () => {
    const client = stubClient({ listTriggerEvents: async () => [] })
    const result = (await tool.run(client, {})) as { note: string }
    expect(result.note).toContain('only start manually or on a schedule')
  })
})

describe('retry_run', () => {
  const tool = toolNamed('retry_run')

  function runDetail(status: string) {
    return {
      run: { id: 'run_1', status, error: 'Provider 429' },
      versionNumber: 28,
      steps: [],
      logs: [],
    } as never
  }

  test('restarts on the latest version and returns the new run id', async () => {
    let seen: unknown
    const client = stubClient({
      getRun: async () => runDetail('failed'),
      retryRun: async (input) => {
        seen = input
        return { runId: 'run_2' }
      },
    })
    const result = (await tool.run(client, { runId: 'run_1' })) as {
      runId: string
      mode: string
      original: { error: string }
      note: string
    }
    expect(seen).toEqual({ runId: 'run_1', mode: 'restart' })
    expect(result.runId).toBe('run_2')
    // Default mode, and the side-effect warning is in the note.
    expect(result.mode).toBe('restart')
    expect(result.note).toContain('side effects')
    // The original stays on the record.
    expect(result.original.error).toBe('Provider 429')
  })

  test('resume says it is testing the OLD version, not the latest', async () => {
    const client = stubClient({
      getRun: async () => runDetail('failed'),
      retryRun: async () => ({ runId: 'run_2' }),
    })
    const result = (await tool.run(client, {
      runId: 'run_1',
      mode: 'resume',
    })) as { note: string }
    expect(result.note).toContain('v28')
    expect(result.note).toContain('NOT the latest')
  })

  // Two live runs of the same work is the thing to avoid; the run viewer only
  // offers Retry on a finished run, so this is the same gate.
  test('refuses a run that is still going', async () => {
    let retried = false
    const client = stubClient({
      getRun: async () => runDetail('running'),
      retryRun: async () => {
        retried = true
        return { runId: 'run_2' }
      },
    })
    const result = (await tool.run(client, { runId: 'run_1' })) as {
      error: string
    }
    expect(result.error).toContain('still running')
    expect(retried).toBe(false)
  })

  test('refuses an unknown mode rather than guessing', async () => {
    const result = (await tool.run(stubClient({}), {
      runId: 'run_1',
      mode: 'rerun',
    })) as { error: string }
    expect(result.error).toContain('"restart" or "resume"')
  })
})
