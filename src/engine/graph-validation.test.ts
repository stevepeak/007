import { describe, expect, test } from 'bun:test'

import { workflowGraphSchema } from './graph'

// The runtime gate rejects a dangling ref in EVERY ref slot `nodeRefs` knows,
// not just the tool/workflow/text/transform/branch/output ones it once listed by
// hand — otherwise the graph parses and the run fails at that node.

function graphWith(passthroughConfig: Record<string, unknown>): unknown {
  return {
    version: 1,
    nodes: [
      {
        id: 't',
        kind: 'trigger',
        label: 'T',
        position: { x: 0, y: 0 },
        config: { triggerKind: 'manual' },
      },
      {
        id: 'p',
        kind: 'passthrough',
        label: 'P',
        position: { x: 200, y: 0 },
        config: passthroughConfig,
      },
      {
        id: 'o',
        kind: 'output',
        label: 'O',
        position: { x: 400, y: 0 },
        config: { source: { kind: 'ref', nodeId: 'p', path: '' } },
      },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'p', condition: null },
      { id: 'e2', source: 'p', target: 'o', condition: null },
    ],
  }
}

describe('checkRefBindings', () => {
  test('a passthrough value ref into a real node parses', () => {
    const g = graphWith({ value: { kind: 'ref', nodeId: 't', path: 'x' } })
    expect(workflowGraphSchema.safeParse(g).success).toBe(true)
  })

  test('rejects a passthrough value ref to a missing node', () => {
    const g = graphWith({ value: { kind: 'ref', nodeId: 'ghost', path: '' } })
    expect(() => workflowGraphSchema.parse(g)).toThrow(
      /Passthrough node p value references missing node ghost/,
    )
  })

  test('rejects a passthrough field ref to a missing node', () => {
    const g = graphWith({
      fields: { name: { kind: 'ref', nodeId: 'ghost', path: '' } },
    })
    expect(() => workflowGraphSchema.parse(g)).toThrow(
      /field 'name' references missing node ghost/,
    )
  })
})
