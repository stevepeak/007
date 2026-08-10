import type { ArgBinding } from './graph'

// Shared resolution for node input bindings (tool `args`, agent `inputs`). A
// binding is either a literal value or a `ref` into a prior node's cached
// output, addressed by a dotted path. Kept in one place so tool and agent nodes
// resolve data identically.

/** The bit of a node an error message needs: what it's called, and what it is. */
export type NodeIdentity = { id: string; label: string; kind: string }

// Walks a dotted path (e.g. "documents.0.id") through a value. Empty path
// returns the value as-is. Missing intermediate keys return undefined.
export function resolvePath(value: unknown, path: string): unknown {
  if (!path) {
    return value
  }
  const segments = path.split('.')
  let current: unknown = value
  for (const seg of segments) {
    if (current === null || current === undefined) {
      return undefined
    }
    if (Array.isArray(current)) {
      const idx = Number.parseInt(seg, 10)
      if (Number.isNaN(idx)) {
        return undefined
      }
      current = current[idx]
      continue
    }
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[seg]
      continue
    }
    return undefined
  }
  return current
}

/**
 * The run's node-output cache, carrying the graph's node identities alongside
 * the values. It IS a `Map<string, unknown>` — every engine signature still
 * takes a plain Map, and a caller that builds one by hand (tests, sub-agents)
 * keeps working — but when the map came from the Scheduler it can also name a
 * node the way the author sees it on the canvas. Binding errors are read by
 * workflow authors in the run viewer, and a raw uuid tells them nothing about
 * which box on their graph is mis-wired.
 */
export class NodeOutputs extends Map<string, unknown> {
  /** nodeId → `"Label" (kind)`, precomputed for every node in the graph. */
  private readonly identities: Map<string, string>

  // Structural on purpose — the identity triple is all this needs, so a
  // `WorkflowNode[]` fits without dragging the node union in here.
  constructor(nodes: readonly NodeIdentity[] = []) {
    super()
    // Labels are author-supplied and need not be unique, so a short id tail is
    // appended to the duplicated ones — an error must point at ONE node.
    const labelCounts = new Map<string, number>()
    for (const n of nodes) {
      labelCounts.set(n.label, (labelCounts.get(n.label) ?? 0) + 1)
    }
    this.identities = new Map(
      nodes.map((n) => {
        const dup = (labelCounts.get(n.label) ?? 0) > 1
        const tail = dup ? ` ${shortId(n.id)}` : ''
        return [n.id, `"${n.label}" (${n.kind}${tail})`]
      }),
    )
  }

  /** Whether this node belongs to the graph at all (vs. a stale/foreign ref). */
  knows(nodeId: string): boolean {
    return this.identities.has(nodeId)
  }

  /** `"Extract text" (tool)`, or a bare id for a node outside this graph. */
  describe(nodeId: string): string {
    return this.identities.get(nodeId) ?? `node ${nodeId}`
  }
}

// The uuid tail is enough to tell same-labelled siblings apart without dragging
// a 36-character id through a sentence meant to be read.
function shortId(id: string): string {
  return id.length > 8 ? `…${id.slice(-8)}` : id
}

/**
 * Names a node for an error message: `"Extract text" (tool)` when the outputs
 * map knows the graph, otherwise the bare id. Use this anywhere the engine
 * would otherwise interpolate a raw node id into a message an author reads.
 */
export function describeNode(
  nodeOutputs: Map<string, unknown>,
  nodeId: string,
): string {
  return nodeOutputs instanceof NodeOutputs
    ? nodeOutputs.describe(nodeId)
    : `node ${nodeId}`
}

// Resolves a single binding to a concrete value. `ctx` identifies the consuming
// node + input name for a clear error when a ref points at a node that has not
// produced an output (e.g. an unreachable branch arm or a mis-wired graph).
export function resolveBinding(
  binding: ArgBinding,
  nodeOutputs: Map<string, unknown>,
  ctx: { nodeId: string; name: string },
): unknown {
  if (binding.kind === 'literal') {
    return binding.value
  }
  const source = nodeOutputs.get(binding.nodeId)
  if (source === undefined) {
    throw new Error(unresolvedRefMessage(binding, nodeOutputs, ctx))
  }
  return resolvePath(source, binding.path)
}

// The two ways a ref fails to resolve, told apart so the author gets the fix
// rather than a symptom: the producer isn't in the graph (stale binding), or it
// is but never ran (a decision node routed around it — by far the common case
// when two branch arms converge on one Output bound to only one of them).
function unresolvedRefMessage(
  binding: Extract<ArgBinding, { kind: 'ref' }>,
  nodeOutputs: Map<string, unknown>,
  ctx: { nodeId: string; name: string },
): string {
  const consumer = describeNode(nodeOutputs, ctx.nodeId)
  const producer = describeNode(nodeOutputs, binding.nodeId)
  const lead = `${consumer} can't resolve its '${ctx.name}' input`
  const foreign =
    nodeOutputs instanceof NodeOutputs && !nodeOutputs.knows(binding.nodeId)
  if (foreign) {
    return `${lead}: it references ${producer}, which isn't part of this graph — it was deleted, or it sits outside this subgraph. Re-bind the input to a node on this graph.`
  }
  const read = binding.path ? `${producer}.${binding.path}` : producer
  return `${lead}: it reads ${read}, but that node produced no output in this run — it never ran. A branch or switch routed around it, or it isn't upstream of ${consumer}. Bind this input to a node that runs on the same path.`
}
