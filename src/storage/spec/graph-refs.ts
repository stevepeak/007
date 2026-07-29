// Translate a workflow graph between its two reference forms:
//
//   • DB form   — agent nodes hold `config.agentId` (a UUID), workflow nodes
//                 hold `config.workflowId` (a UUID). This is what the engine
//                 runs and what `wf_workflow_version.graph` stores.
//   • spec form — the same nodes hold `config.agentSlug` / `config.workflowSlug`
//                 instead. This is what the portable spec carries so a graph is
//                 valid in any environment.
//
// Both directions deep-clone the graph and rewrite every agent/workflow node,
// recursing into `iteration` subgraphs (the only place nodes nest). Nothing
// else is touched. An unresolvable reference throws with context rather than
// silently dropping to an empty ref.

/** A node's `config`, seen structurally so we can rewrite refs without the
 * engine's discriminated-union types leaking into the translation layer. */
type NodeLike = {
  kind?: string
  config?: Record<string, unknown>
}

type GraphLike = {
  nodes?: NodeLike[]
  [k: string]: unknown
}

function mapNodes(
  graph: GraphLike,
  mapNode: (node: NodeLike) => void,
): void {
  for (const node of graph.nodes ?? []) {
    mapNode(node)
    if (node.kind === 'iteration') {
      const subgraph = node.config?.subgraph as GraphLike | undefined
      if (subgraph) mapNodes(subgraph, mapNode)
    }
  }
}

/**
 * DB → spec: rewrite `agentId`→`agentSlug` and `workflowId`→`workflowSlug`.
 * `agentSlugById` / `workflowSlugById` must resolve every referenced id. An
 * empty ref (`''`, an unpicked node in a draft) is preserved as an empty slug.
 */
export function graphIdsToSlugs(
  graph: unknown,
  maps: {
    agentSlugById: Map<string, string>
    workflowSlugById: Map<string, string>
  },
): unknown {
  const clone = structuredClone(graph) as GraphLike
  mapNodes(clone, (node) => {
    const config = node.config
    if (!config) return
    if (node.kind === 'agent') {
      const id = (config.agentId as string | undefined) ?? ''
      config.agentSlug = id ? resolve(maps.agentSlugById, id, 'agent', 'id') : ''
      delete config.agentId
    } else if (node.kind === 'workflow') {
      const id = (config.workflowId as string | undefined) ?? ''
      config.workflowSlug = id
        ? resolve(maps.workflowSlugById, id, 'workflow', 'id')
        : ''
      delete config.workflowId
    }
  })
  return clone
}

/**
 * spec → DB: the inverse. `agentIdBySlug` / `workflowIdBySlug` must resolve
 * every referenced slug. An empty slug is preserved as an empty id.
 */
export function graphSlugsToIds(
  graph: unknown,
  maps: {
    agentIdBySlug: Map<string, string>
    workflowIdBySlug: Map<string, string>
  },
): unknown {
  const clone = structuredClone(graph) as GraphLike
  mapNodes(clone, (node) => {
    const config = node.config
    if (!config) return
    if (node.kind === 'agent') {
      const slug = (config.agentSlug as string | undefined) ?? ''
      config.agentId = slug
        ? resolve(maps.agentIdBySlug, slug, 'agent', 'slug')
        : ''
      delete config.agentSlug
    } else if (node.kind === 'workflow') {
      const slug = (config.workflowSlug as string | undefined) ?? ''
      config.workflowId = slug
        ? resolve(maps.workflowIdBySlug, slug, 'workflow', 'slug')
        : ''
      delete config.workflowSlug
    }
  })
  return clone
}

function resolve(
  map: Map<string, string>,
  key: string,
  kind: string,
  keyKind: 'id' | 'slug',
): string {
  const value = map.get(key)
  if (value === undefined) {
    throw new Error(
      `Graph references ${kind} ${keyKind} "${key}", which does not exist ` +
        `${keyKind === 'slug' ? 'in the bundle or target database' : 'as a slugged row'}.`,
    )
  }
  return value
}
