import { ITERATION_MAX_ITEMS_DEFAULT, type WorkflowGraph } from './graph-schema'
import {
  ITERATION_ITEM_TRIGGER_KIND,
  MANUAL_TRIGGER_KIND,
  PERIODIC_TRIGGER_KIND,
} from './trigger-registry'

// The trigger a new workflow is seeded with (chosen in the creation flow).
export type NewWorkflowTrigger =
  | { mode: 'manual' }
  | { mode: 'periodic'; cron: string }
  // `eventLabel` is the event's human description, used as the trigger node's
  // display label so the internal `event` kind is never surfaced. Falls back to
  // a generic 'On event' when the caller has no description on hand.
  | { mode: 'event'; event: string; eventLabel?: string }

/**
 * Build the minimal valid starter graph for a new workflow: the chosen trigger
 * wired straight into an Output node. The editor takes over from here.
 */
export function buildStarterGraph(trigger: NewWorkflowTrigger): WorkflowGraph {
  const triggerId = crypto.randomUUID()
  const outputId = crypto.randomUUID()

  const config =
    trigger.mode === 'manual'
      ? { triggerKind: MANUAL_TRIGGER_KIND }
      : trigger.mode === 'periodic'
        ? { triggerKind: PERIODIC_TRIGGER_KIND, cron: trigger.cron }
        : { triggerKind: trigger.event }

  const label =
    trigger.mode === 'manual'
      ? 'Manual start'
      : trigger.mode === 'periodic'
        ? 'On schedule'
        : (trigger.eventLabel ?? 'On event')

  return {
    version: 1,
    nodes: [
      {
        id: triggerId,
        kind: 'trigger',
        label,
        position: { x: 0, y: 0 },
        informUser: { mode: 'off' },
        config,
      },
      {
        id: outputId,
        kind: 'output',
        label: 'Output',
        position: { x: 320, y: 0 },
        informUser: { mode: 'off' },
        config: {},
      },
    ],
    edges: [
      {
        id: crypto.randomUUID(),
        source: triggerId,
        target: outputId,
        condition: null,
      },
    ],
  }
}

/**
 * Give every unbounded iteration node in a graph the default fan-out limit for
 * its execution mode, recursing into iteration subgraphs.
 *
 * Applied at PUBLISH, so the bound lands where it can be enforced without ever
 * being enforced retroactively: a version published from here on is bounded,
 * while versions already published keep running under the permissive
 * `ITERATION_MAX_ITEMS_FALLBACK` (see `iterationItemLimit`). Drafts are left
 * alone — the Issues panel flags an unbounded loop there, which is the point at
 * which the author can still choose a number that suits their list.
 *
 * Only ever fills a gap: a node that already declares `maxItems` keeps it, even
 * one above its mode's ceiling (that's an authoring error to fix, not a value to
 * silently rewrite). Returns the same graph object when there is nothing to fill.
 */
export function backfillIterationLimits(graph: WorkflowGraph): WorkflowGraph {
  let changed = false
  const nodes = graph.nodes.map((node) => {
    if (node.kind !== 'iteration') return node
    const subgraph = backfillIterationLimits(node.config.subgraph)
    const maxItems =
      node.config.maxItems ??
      ITERATION_MAX_ITEMS_DEFAULT[node.config.itemExecution]
    if (
      maxItems === node.config.maxItems &&
      subgraph === node.config.subgraph
    ) {
      return node
    }
    changed = true
    return { ...node, config: { ...node.config, maxItems, subgraph } }
  })
  return changed ? { ...graph, nodes } : graph
}

/**
 * Build the minimal valid subgraph an iteration node is seeded with: an
 * `iteration_item` trigger (its output is the current list element) wired
 * straight into an Output node. In the editor these two render as the `Item` and
 * `Result` bookend nodes inside the iteration container; the author drops work
 * nodes between them. Positions are relative to the container's top-left, offset
 * below its header.
 */
export function buildIterationSubgraph(): WorkflowGraph {
  const triggerId = crypto.randomUUID()
  const outputId = crypto.randomUUID()
  return {
    version: 1,
    nodes: [
      {
        id: triggerId,
        kind: 'trigger',
        label: 'Item',
        position: { x: 24, y: 72 },
        informUser: { mode: 'off' },
        config: { triggerKind: ITERATION_ITEM_TRIGGER_KIND },
      },
      {
        id: outputId,
        kind: 'output',
        label: 'Result',
        position: { x: 300, y: 72 },
        informUser: { mode: 'off' },
        config: {},
      },
    ],
    edges: [
      {
        id: crypto.randomUUID(),
        source: triggerId,
        target: outputId,
        condition: null,
      },
    ],
  }
}
