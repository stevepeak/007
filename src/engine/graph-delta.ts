import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from './graph'
import { stableStringify } from './stable-stringify'

export type GraphDelta = {
  nodesAdded: string[]
  nodesRemoved: string[]
  nodesChanged: string[]
  edgesAdded: number
  edgesRemoved: number
}

/**
 * What differs between two graphs, by id — the one answer to "does this draft
 * change what runs?". Editor-only layout (node `position`, an iteration's
 * `width`/`height`) is ignored: a node that only moved did not change anything.
 * Everything else on a node counts, `execution` included. Iteration subgraphs
 * are compared node by node, keyed `iterationId/innerId`, so moving an inner
 * node is not a change of the iteration either.
 */
export function graphDelta(args: {
  before: WorkflowGraph | null | undefined
  after: WorkflowGraph
}): GraphDelta {
  const a = flatten({ graph: args.before })
  const b = flatten({ graph: args.after })
  return {
    nodesAdded: [...b.nodes.keys()].filter((k) => !a.nodes.has(k)).map((k) => b.nodes.get(k)!.name),
    nodesRemoved: [...a.nodes.keys()].filter((k) => !b.nodes.has(k)).map((k) => a.nodes.get(k)!.name),
    nodesChanged: [...b.nodes.keys()]
      .filter((k) => a.nodes.has(k) && a.nodes.get(k)!.hash !== b.nodes.get(k)!.hash)
      .map((k) => b.nodes.get(k)!.name),
    edgesAdded: [...b.edges].filter((k) => !a.edges.has(k)).length,
    edgesRemoved: [...a.edges].filter((k) => !b.edges.has(k)).length,
  }
}

export function isEmptyGraphDelta(d: GraphDelta): boolean {
  return (
    d.nodesAdded.length === 0 &&
    d.nodesRemoved.length === 0 &&
    d.nodesChanged.length === 0 &&
    d.edgesAdded === 0 &&
    d.edgesRemoved === 0
  )
}

type Flat = {
  nodes: Map<string, { name: string; hash: string }>
  edges: Set<string>
}

function flatten(args: {
  graph: WorkflowGraph | null | undefined
  prefix?: string
  into?: Flat
}): Flat {
  const out: Flat = args.into ?? { nodes: new Map(), edges: new Set() }
  const prefix = args.prefix ?? ''
  for (const n of args.graph?.nodes ?? []) {
    const key = `${prefix}${n.id}`
    out.nodes.set(key, { name: `${n.label} (${key})`, hash: nodeHash(n) })
    if (n.kind === 'iteration') {
      flatten({ graph: n.config.subgraph, prefix: `${key}/`, into: out })
    }
  }
  for (const e of args.graph?.edges ?? []) out.edges.add(`${prefix}${edgeKey(e)}`)
  return out
}

function nodeHash(n: WorkflowNode): string {
  const { position: _position, ...rest } = n
  if (rest.kind !== 'iteration') return stableStringify(rest)
  const { subgraph: _subgraph, width: _width, height: _height, ...config } = rest.config
  return stableStringify({ ...rest, config })
}

function edgeKey(e: WorkflowEdge): string {
  return `${e.source}>${e.target}>${e.condition ?? ''}`
}
