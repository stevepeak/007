import { beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'

import type { WorkflowGraph, WorkflowNode } from '../../engine/graph'
import type { ToolRegistry } from '../../engine/tool-registry'
import type { WfDb } from '../../storage/client'
import { createWorkflow, updateDraft } from '../../storage/data'
import { freshDb } from '../../storage/db-test-helpers'

import { testHandlerCtx, testHandlerOptions } from './handler-test-helpers'
import { buildWorkflowHandlers } from './workflows'

// `validateGraph` end to end: the graph resolution (supplied / draft /
// published / version) and the one check only the server can make — Tool-node
// args against the registry's zod schemas, converted the same way `listTools`
// converts them. The DB is a real migrated in-memory D1.

// The real ART-146 schema: three required, nullable fields.
const escalateInput = z.object({
  internalNote: z.string().nullable(),
  publicNote: z.string().nullable(),
  lock: z.boolean().nullable(),
})

function options() {
  const toolRegistry: ToolRegistry<unknown> = new Map([
    [
      'escalate_chat',
      {
        id: 'escalate_chat',
        name: 'Escalate',
        description: '',
        kind: 'ai-tool',
        inputSchema: escalateInput,
        build: () => {
          throw new Error('unused')
        },
      },
    ],
  ])
  return testHandlerOptions({ config: { toolRegistry } })
}

const pos = { x: 0, y: 0 }
function graphWith(args: Record<string, unknown>): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      {
        id: 't',
        kind: 'trigger',
        position: pos,
        label: 'Chat',
        informUser: { mode: 'off' },
        config: { triggerKind: 'chat_message' },
      },
      {
        id: 'esc',
        kind: 'tool',
        position: pos,
        label: 'Escalate',
        informUser: { mode: 'off' },
        config: { toolId: 'escalate_chat', args },
      } as WorkflowNode,
      {
        id: 'o',
        kind: 'output',
        position: pos,
        label: 'Out',
        informUser: { mode: 'off' },
        config: { source: { kind: 'ref', nodeId: 'esc', path: '' } },
      },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'esc', condition: null },
      { id: 'e2', source: 'esc', target: 'o', condition: null },
    ],
  }
}

const v25Args = {
  note: { kind: 'ref', nodeId: 't', path: 'userText' },
  lock: { kind: 'literal', value: 'false' },
}
const v27Args = {
  internalNote: { kind: 'literal', value: 'Chat escalated' },
  publicNote: { kind: 'literal', value: 'Chat escalated' },
  lock: { kind: 'literal', value: false },
}

describe('validateGraph handler', () => {
  let db: WfDb
  beforeEach(() => {
    db = freshDb()
  })

  test('a supplied graph: the ART-146 args are three errors + a warning, the fixed args none', async () => {
    const handlers = buildWorkflowHandlers(options())
    const bad = await handlers.validateGraph(
      testHandlerCtx(db, { graph: graphWith(v25Args) }),
    )
    expect(bad.source).toBe('supplied')
    expect(bad.errors).toBe(3)
    expect(bad.warnings).toBe(1)
    expect(bad.issues.map((i) => i.message).join('\n')).toContain(
      'Store the boolean or null false, not the text "false"',
    )

    const good = await handlers.validateGraph(
      testHandlerCtx(db, { graph: graphWith(v27Args) }),
    )
    expect(good.errors).toBe(0)
    expect(good.issues).toEqual([])
  })

  test('workflowId lints the draft when there is one, else the published graph', async () => {
    const handlers = buildWorkflowHandlers(options())
    const { workflowId } = await createWorkflow(db, {
      name: 'Legal chat',
      createdBy: 'tester',
      graph: graphWith(v27Args),
    })
    const published = await handlers.validateGraph(testHandlerCtx(db, { workflowId }))
    expect(published.source).toBe('published')
    expect(published.versionNumber).toBe(1)
    expect(published.errors).toBe(0)

    await updateDraft(db, {
      workflowId,
      graph: graphWith(v25Args),
      lastEditedBy: 'tester',
    })
    const draft = await handlers.validateGraph(testHandlerCtx(db, { workflowId }))
    expect(draft.source).toBe('draft')
    expect(draft.errors).toBe(3)
  })

  test('versionId lints that version; nothing to lint is a 400', async () => {
    const handlers = buildWorkflowHandlers(options())
    const { workflowId, versionId } = await createWorkflow(db, {
      name: 'Legal chat',
      createdBy: 'tester',
      graph: graphWith(v25Args),
    })
    const v = await handlers.validateGraph(testHandlerCtx(db, { versionId }))
    expect(v.source).toBe('version')
    expect(v.versionNumber).toBe(1)
    expect(v.errors).toBe(3)
    expect(workflowId).toBeTruthy()

    await expect(handlers.validateGraph(testHandlerCtx(db, {}))).rejects.toThrow(
      'needs one of graph, versionId or workflowId',
    )
  })

  test('the strict runtime gate is reported too', async () => {
    const handlers = buildWorkflowHandlers(options())
    const g = graphWith(v27Args)
    // Two triggers: the shape schema saves it, the runtime schema rejects it.
    g.nodes.push({ ...g.nodes[0], id: 't2' })
    const r = await handlers.validateGraph(testHandlerCtx(db, { graph: g }))
    expect(r.issues.some((i) => i.message.startsWith('Runtime check:'))).toBe(
      true,
    )
    expect(r.errors).toBeGreaterThan(0)
  })
})
