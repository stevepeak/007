import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import type { JsonSchema } from './agent-output-scan'
import type { WorkflowGraph, WorkflowNode } from './graph'
import { collectToolArgIssues, type ToolInputSchemas } from './graph-tool-args'

const pos = { x: 0, y: 0 }

// The real schema behind ART-146, in the shape the server hands the editor
// (`toJsonSchema(entry.inputSchema, 'input')`): three REQUIRED nullable fields.
const escalate = z.object({
  internalNote: z.string().max(2_000).nullable(),
  publicNote: z.string().max(2_000).nullable(),
  lock: z.boolean().nullable(),
})
const search = z.object({
  query: z.string(),
  maxResults: z.number().int().default(8),
  mode: z.enum(['dense', 'sparse']).nullish(),
})

function schemas(): ToolInputSchemas {
  return new Map<string, JsonSchema | undefined>([
    ['escalate_chat', z.toJSONSchema(escalate, { io: 'input' })],
    ['search_knowledge_base', z.toJSONSchema(search, { io: 'input' })],
    ['no_schema', undefined],
  ])
}

function toolNode(
  id: string,
  toolId: string,
  args: Record<string, { kind: 'literal'; value: unknown } | { kind: 'ref'; nodeId: string; path: string }>,
): WorkflowNode {
  return {
    id,
    kind: 'tool',
    position: pos,
    label: id,
    informUser: { mode: 'off' },
    config: { toolId, args },
  }
}

function graph(...nodes: WorkflowNode[]): WorkflowGraph {
  return { version: 1, nodes, edges: [] }
}

const ref = { kind: 'ref' as const, nodeId: 'up', path: 'attorney_rationale' }

describe('collectToolArgIssues', () => {
  test('the ART-146 v25 node: renamed field + string boolean → three errors', () => {
    const g = graph(
      toolNode('esc', 'escalate_chat', {
        note: ref,
        lock: { kind: 'literal', value: 'false' },
      }),
    )
    const issues = collectToolArgIssues(g, schemas())
    expect(issues.every((i) => i.severity === 'error' && i.nodeId === 'esc')).toBe(true)
    const messages = issues.map((i) => i.message)
    const has = (needle: string) =>
      messages.some((m) => m.includes(needle))
    expect(has('"internalNote"')).toBe(true)
    expect(has('"publicNote"')).toBe(true)
    expect(has('"note" is not an input')).toBe(true)
    // The string-boolean gets a concrete fix, not just a complaint.
    expect(has('Store the boolean or null false, not the text "false"')).toBe(true)
    expect(issues).toHaveLength(4)
  })

  test('the v27 node that worked is clean', () => {
    const g = graph(
      toolNode('esc', 'escalate_chat', {
        internalNote: { kind: 'literal', value: 'Chat escalated' },
        publicNote: { kind: 'literal', value: 'Chat escalated' },
        lock: { kind: 'literal', value: false },
      }),
    )
    expect(collectToolArgIssues(g, schemas())).toEqual([])
  })

  test('a null literal satisfies a nullable field; a ref is never judged', () => {
    const g = graph(
      toolNode('esc', 'escalate_chat', {
        internalNote: { kind: 'literal', value: null },
        publicNote: ref,
        lock: ref,
      }),
    )
    expect(collectToolArgIssues(g, schemas())).toEqual([])
  })

  test('defaulted fields are optional; enums are enforced; integers are numbers', () => {
    const ok = graph(
      toolNode('s', 'search_knowledge_base', {
        query: ref,
        maxResults: { kind: 'literal', value: 3 },
        mode: { kind: 'literal', value: 'dense' },
      }),
    )
    expect(collectToolArgIssues(ok, schemas())).toEqual([])

    const bad = graph(
      toolNode('s', 'search_knowledge_base', {
        query: ref,
        mode: { kind: 'literal', value: 'hybrid' },
      }),
    )
    const issues = collectToolArgIssues(bad, schemas())
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('must be one of "dense", "sparse", null')
  })

  test('an unknown tool id is one error and nothing else', () => {
    const g = graph(toolNode('x', 'escalate', { note: ref }))
    const issues = collectToolArgIssues(g, schemas())
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('"escalate" is not in the tool catalog')
  })

  test('a tool without a schema is not judged', () => {
    const g = graph(
      toolNode('x', 'no_schema', { anything: { kind: 'literal', value: 'x' } }),
    )
    expect(collectToolArgIssues(g, schemas())).toEqual([])
  })

  test('tool nodes inside an iteration subgraph are checked too', () => {
    const inner = toolNode('esc', 'escalate_chat', {
      lock: { kind: 'literal', value: 'true' },
    })
    const loop: WorkflowNode = {
      id: 'loop',
      kind: 'iteration',
      position: pos,
      label: 'loop',
      informUser: { mode: 'off' },
      config: {
        source: { kind: 'ref', nodeId: 'up', path: '' },
        subgraph: { version: 1, nodes: [inner], edges: [] },
        maxItems: 10,
        itemExecution: 'inline',
        concurrency: 1,
        stopOnError: true,
        itemTitle: '',
      },
    }
    const issues = collectToolArgIssues(graph(loop), schemas())
    expect(issues.map((i) => i.nodeId)).toEqual(['esc', 'esc', 'esc'])
  })
})
