import { FAILURE_ROUTES, isFailureRoute, type FailureRoute } from './failure-route'
import { buildAdjacency } from './graph-adjacency'
import { nodeRefs } from './graph-bindings'
import {
  workflowGraphShapeSchema,
  type OnFailureNode,
  type TriggerNode,
  type WorkflowGraph,
} from './graph-schema'
import { RUN_FAILURE_TRIGGER_KIND } from './trigger-registry'

// The `on-failure` node and the subgraph hanging off it.
//
// The handler is part of the workflow's graph (one version, one manifest) but
// never part of its walk: the node is a bookend with no incoming edges, so the
// main scheduler never selects it, and every node below it waits on an edge
// that never comes alive. When the run fails, the engine cuts the arm for that
// route out of the same version (`failureHandlerGraphOf`) and runs it as a child
// run — the same trick a durable iteration item uses to run its container's
// subgraph without a version of its own.

/** The graph's failure handler, if it has one. */
export function failureHandlerOf(graph: WorkflowGraph): OnFailureNode | undefined {
  return graph.nodes.find((n): n is OnFailureNode => n.kind === 'on-failure')
}

/** The handler and every node reachable from it, by id. */
export function failureHandlerNodeIds(
  graph: WorkflowGraph,
  handlerId: string,
): Set<string> {
  const { outgoing } = buildAdjacency(graph)
  const seen = new Set<string>([handlerId])
  const queue = [handlerId]
  while (queue.length > 0) {
    const id = queue.pop()!
    for (const e of outgoing.get(id) ?? []) {
      if (seen.has(e.target)) continue
      seen.add(e.target)
      queue.push(e.target)
    }
  }
  return seen
}

/** The routes the handler has an arm for — a route with none spawns nothing. */
export function failureHandlerRoutes(
  graph: WorkflowGraph,
  handlerId: string,
): Set<FailureRoute> {
  const routes = new Set<FailureRoute>()
  for (const e of graph.edges) {
    if (e.source === handlerId && isFailureRoute(e.condition)) {
      routes.add(e.condition)
    }
  }
  return routes
}

/**
 * Every way a graph's failure handler is malformed, as messages. Shared by the
 * strict runtime gate and the author-time Issues panel so the two cannot drift.
 */
export function failureHandlerProblems(graph: WorkflowGraph): string[] {
  const handlers = graph.nodes.filter((n) => n.kind === 'on-failure')
  if (handlers.length === 0) return []
  if (handlers.length > 1) {
    return [`A workflow can have at most one On Failure node (found ${handlers.length}).`]
  }
  const handler = handlers[0]
  const problems: string[] = []
  const inside = failureHandlerNodeIds(graph, handler.id)
  for (const e of graph.edges) {
    if (e.target === handler.id) {
      problems.push(`On Failure node ${handler.id} cannot have incoming edges (edge ${e.id}).`)
    } else if (e.source === handler.id && !isFailureRoute(e.condition)) {
      problems.push(
        `On Failure node ${handler.id} edge ${e.id} must name a failure route (${FAILURE_ROUTES.join(', ')}), not '${e.condition ?? 'null'}'.`,
      )
    } else if (inside.has(e.target) && !inside.has(e.source)) {
      // Joining the handler to the main graph would make a handler node wait on
      // a main-graph node that the handler run does not contain.
      problems.push(
        `Node ${e.target} is reached from both the workflow and its On Failure handler (edge ${e.id}); the handler must be detached.`,
      )
    }
  }
  for (const n of graph.nodes) {
    if (inside.has(n.id) && n.kind === 'output') {
      problems.push(`Output node ${n.id} is inside the On Failure handler; a handler has no answer.`)
    }
    for (const { slot, ref } of nodeRefs(n)) {
      if (inside.has(n.id) === inside.has(ref.nodeId)) continue
      problems.push(
        inside.has(n.id)
          ? `Node ${n.id} ${slot} reads ${ref.nodeId}, outside the On Failure handler — a handler can only read the failure and its own nodes.`
          : `Node ${n.id} ${slot} reads ${ref.nodeId}, inside the On Failure handler, which never runs in the main walk.`,
      )
    }
  }
  return problems
}

/**
 * The runnable graph for one route of the handler: the `on-failure` node becomes
 * a `run_failure` trigger with the SAME id (so refs into it resolve to the
 * failure payload), only that route's edges leave it, and only the nodes those
 * edges reach are kept.
 *
 * Pruning to what the route reaches, rather than keeping the whole handler, is
 * what makes fanning several routes into one node work: a cleanup node wired
 * from both `timeout` and `cancelled` keeps one live edge, instead of waiting
 * forever on the one that did not fire.
 */
export function failureHandlerGraphOf(
  graphJson: unknown,
  nodeId: string,
  route: FailureRoute,
): WorkflowGraph {
  const graph = workflowGraphShapeSchema.parse(graphJson)
  const handler = graph.nodes.find((n) => n.id === nodeId)
  if (!handler || handler.kind !== 'on-failure') {
    throw new Error(
      `On Failure node ${nodeId} is not in this workflow version — its handler cannot be run.`,
    )
  }
  const liveEdges = graph.edges.filter((e) => {
    return e.source !== nodeId || e.condition === route
  })
  const reached = failureHandlerNodeIds(
    { ...graph, edges: liveEdges },
    nodeId,
  )
  const trigger: TriggerNode = {
    id: handler.id,
    position: handler.position,
    label: handler.label,
    informUser: { mode: 'off' },
    kind: 'trigger',
    config: {
      triggerKind: RUN_FAILURE_TRIGGER_KIND,
      engine: handler.config.engine,
    },
  }
  return {
    version: 1,
    nodes: graph.nodes
      .filter((n) => reached.has(n.id))
      .map((n) => (n.id === nodeId ? trigger : n)),
    edges: liveEdges
      .filter((e) => reached.has(e.source) && reached.has(e.target))
      .map((e) => (e.source === nodeId ? { ...e, condition: null } : e)),
  }
}
