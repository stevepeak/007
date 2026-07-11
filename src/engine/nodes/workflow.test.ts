import { describe, expect, test } from 'bun:test'

import {
  workflowGraphSchema,
  type WfRunManifestEntry,
  type WorkflowCallNode,
  type WorkflowGraph,
} from '../graph'
import { collectGraphIssues } from '../graph-issues'
import type { RunNodeContext } from '../run-node'
import { executeWorkflowNode } from './workflow'

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

// A minimal identity callee: manual trigger wired straight to an output, so its
// output is exactly its trigger input.
const identityCallee: WorkflowGraph = {
  version: 1,
  nodes: [
    {
      id: 'ct',
      kind: 'trigger',
      label: 'Start',
      position: { x: 0, y: 0 },
      config: { triggerKind: 'manual' },
    },
    {
      id: 'co',
      kind: 'output',
      label: 'Out',
      position: { x: 200, y: 0 },
      config: {},
    },
  ],
  edges: [{ id: 'e1', source: 'ct', target: 'co', condition: null }],
}

// A callee with a branch, to prove the subgraph actually WALKS (not just echoes
// the input): truthy input takes the `yes` output, empty takes `no`. Both arms
// pass the input through, so the output value equals the input — but reaching it
// required running the branch node.
const branchCallee: WorkflowGraph = {
  version: 1,
  nodes: [
    {
      id: 'ct',
      kind: 'trigger',
      label: 'Start',
      position: { x: 0, y: 0 },
      config: { triggerKind: 'manual' },
    },
    {
      id: 'b',
      kind: 'branch',
      label: 'Truthy?',
      position: { x: 100, y: 0 },
      config: { path: '', operator: 'is_not_empty' },
    },
    {
      id: 'yes',
      kind: 'output',
      label: 'Yes',
      position: { x: 200, y: 0 },
      config: {},
    },
    {
      id: 'no',
      kind: 'output',
      label: 'No',
      position: { x: 200, y: 100 },
      config: {},
    },
  ],
  edges: [
    { id: 'e1', source: 'ct', target: 'b', condition: null },
    { id: 'e2', source: 'b', target: 'yes', condition: 'yes' },
    { id: 'e3', source: 'b', target: 'no', condition: 'no' },
  ],
}

const workflowEntry = (graph: WorkflowGraph): WfRunManifestEntry => ({
  kind: 'workflow',
  id: 'wf-callee',
  versionId: 'v1',
  versionNumber: 3,
  name: 'Callee',
  graph,
})

const callNode = (
  config: Partial<WorkflowCallNode['config']> = {},
): WorkflowCallNode => ({
  id: 'w',
  kind: 'workflow',
  position: { x: 0, y: 0 },
  label: 'Call',
  config: { workflowId: 'wf-callee', inputs: {}, ...config },
})

const ctxWith = (
  manifest: WfRunManifestEntry[],
  nodeOutputs: Map<string, unknown> = new Map(),
): RunNodeContext<unknown> =>
  ({ manifest, nodeOutputs }) as unknown as RunNodeContext<unknown>

// ---------------------------------------------------------------------------
// executeWorkflowNode
// ---------------------------------------------------------------------------

describe('executeWorkflowNode', () => {
  test('runs the frozen callee inline and returns its output (pass-through)', async () => {
    const r = await executeWorkflowNode({
      node: callNode(),
      input: { hello: 'world' },
      ctx: ctxWith([workflowEntry(identityCallee)]),
    })
    expect(r.output).toEqual({ hello: 'world' })
    expect(r.meta).toEqual({
      workflowId: 'wf-callee',
      versionId: 'v1',
      versionNumber: 3,
      name: 'Callee',
    })
  })

  test('walks the callee subgraph (branch routes the pass-through input)', async () => {
    const ctx = ctxWith([workflowEntry(branchCallee)])
    expect(
      (await executeWorkflowNode({ node: callNode(), input: 'present', ctx }))
        .output,
    ).toBe('present')
    expect(
      (await executeWorkflowNode({ node: callNode(), input: '', ctx })).output,
    ).toBe('')
  })

  test('input bindings build the callee trigger payload (literal + ref)', async () => {
    const nodeOutputs = new Map<string, unknown>([['up', { user: 'bob' }]])
    const r = await executeWorkflowNode({
      node: callNode({
        inputs: {
          greeting: { kind: 'literal', value: 'hi' },
          name: { kind: 'ref', nodeId: 'up', path: 'user' },
        },
      }),
      input: 'ignored-when-inputs-present',
      ctx: ctxWith([workflowEntry(identityCallee)], nodeOutputs),
    })
    expect(r.output).toEqual({ greeting: 'hi', name: 'bob' })
  })

  test('throws when the workflow is not in the run manifest', async () => {
    await expect(
      executeWorkflowNode({
        node: callNode({ workflowId: 'missing' }),
        input: null,
        ctx: ctxWith([]),
      }),
    ).rejects.toThrow(/not in the run manifest/)
  })
})

// ---------------------------------------------------------------------------
// Schema + author-time issues
// ---------------------------------------------------------------------------

describe('workflow node schema', () => {
  const wrap = (node: WorkflowCallNode): unknown => ({
    version: 1,
    nodes: [
      {
        id: 't',
        kind: 'trigger',
        label: 'T',
        position: { x: 0, y: 0 },
        config: { triggerKind: 'manual' },
      },
      node,
      {
        id: 'o',
        kind: 'output',
        label: 'O',
        position: { x: 400, y: 0 },
        config: {},
      },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'w', condition: null },
      { id: 'e2', source: 'w', target: 'o', condition: null },
    ],
  })

  test('a well-formed workflow node parses', () => {
    expect(() => workflowGraphSchema.parse(wrap(callNode()))).not.toThrow()
  })

  test('rejects an input ref pointing at a missing node', () => {
    const bad = callNode({
      inputs: { x: { kind: 'ref', nodeId: 'ghost', path: '' } },
    })
    expect(() => workflowGraphSchema.parse(wrap(bad))).toThrow(
      /references missing node ghost/,
    )
  })

  test('flags an author-time error when no workflow is selected', () => {
    const issues = collectGraphIssues(
      wrap(callNode({ workflowId: '' })) as WorkflowGraph,
    )
    const issue = issues.find(
      (i) => i.nodeId === 'w' && /No workflow selected/.test(i.message),
    )
    expect(issue?.severity).toBe('error')
  })
})
