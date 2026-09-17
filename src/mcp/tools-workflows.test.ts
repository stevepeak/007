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
      },
    ])
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
