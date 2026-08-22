import { describe, expect, it } from 'bun:test'

import {
  BOOKEND_NODE_KINDS,
  DECISION_NODE_KINDS,
  isBookendKind,
  isDecisionKind,
  isWfNodeKind,
  NODE_KIND_CATEGORY_ORDER,
  NODE_KIND_REGISTRY,
  nodeKindLabel,
  WF_NODE_KINDS,
  type WfNodeKind,
} from './graph-kinds'
import { workflowNodeSchema } from './graph-schema'
import { NODE_KIND_SEEDS } from './node-kind-seeds'

// The registry's whole promise is that a new node kind is ONE object entry and
// everything else either follows automatically or fails to compile. Most of that
// is enforced by the type system (`Record<WfNodeKind, …>` + `satisfies never`),
// which no runtime test can observe. These cover the parts that can drift
// silently at run time: the derived lists, and whether each seed actually
// produces a node the graph schema accepts.

describe('NODE_KIND_REGISTRY', () => {
  it('derives WF_NODE_KINDS from the registry keys', () => {
    expect([...WF_NODE_KINDS].sort()).toEqual(
      (Object.keys(NODE_KIND_REGISTRY) as WfNodeKind[]).sort(),
    )
  })

  it('describes every kind', () => {
    for (const kind of WF_NODE_KINDS) {
      const d = NODE_KIND_REGISTRY[kind]
      expect(d.label.length, `${kind} needs a label`).toBeGreaterThan(0)
      expect(d.icon.length, `${kind} needs an icon`).toBeGreaterThan(0)
    }
  })

  it('derives the decision and bookend sets from their columns', () => {
    expect(DECISION_NODE_KINDS).toEqual(['branch', 'switch'])
    expect(BOOKEND_NODE_KINDS).toEqual(['trigger', 'note', 'output'])
    expect(isDecisionKind('branch')).toBe(true)
    expect(isDecisionKind('agent')).toBe(false)
    expect(isBookendKind({ kind: 'note' })).toBe(true)
    expect(isBookendKind({ kind: 'agent' })).toBe(false)
  })

  it('labels a known kind and passes an unknown one through', () => {
    expect(nodeKindLabel('feature-request')).toBe('Feature Request')
    // Unlabelled fallback matters: run rows persist a kind string, and an old
    // row naming a kind this build no longer has must still render.
    expect(nodeKindLabel('not-a-kind')).toBe('not-a-kind')
    expect(isWfNodeKind('agent')).toBe(true)
    expect(isWfNodeKind('not-a-kind')).toBe(false)
  })

  it('only files palette entries under a rendered category', () => {
    for (const kind of WF_NODE_KINDS) {
      const { palette } = NODE_KIND_REGISTRY[kind]
      if (!palette) continue
      // A category outside the order array would make the item unreachable —
      // NodePalette renders sections, not leftovers.
      expect(NODE_KIND_CATEGORY_ORDER, kind).toContain(palette.category)
    }
  })

  it('leaves exactly the template-owned bookends out of the palette', () => {
    const unaddable = WF_NODE_KINDS.filter(
      (kind) => !NODE_KIND_REGISTRY[kind].palette,
    )
    expect(unaddable).toEqual(['trigger', 'output'])
  })
})

describe('NODE_KIND_SEEDS', () => {
  it('covers every kind, and seeds exactly the palette-addable ones', () => {
    for (const kind of WF_NODE_KINDS) {
      expect(Object.hasOwn(NODE_KIND_SEEDS, kind), `${kind} needs a seed`).toBe(
        true,
      )
      // The two tables must agree: a kind the author can drag in has to know how
      // to start life, and one that can't must not offer a seed.
      expect(NODE_KIND_SEEDS[kind] != null, kind).toBe(
        NODE_KIND_REGISTRY[kind].palette != null,
      )
    }
  })

  it('seeds a node the graph schema accepts', () => {
    for (const kind of WF_NODE_KINDS) {
      const seed = NODE_KIND_SEEDS[kind]
      if (!seed) continue
      const parsed = workflowNodeSchema.safeParse({
        ...seed({ toolId: 'test-tool' }),
        id: `n-${kind}`,
        position: { x: 0, y: 0 },
      })
      // A seed that doesn't parse means dragging that node onto the canvas
      // produces a graph that fails to save — worth catching here rather than
      // in the editor.
      expect(parsed.success, `${kind}: ${parsed.error?.message}`).toBe(true)
    }
  })
})
