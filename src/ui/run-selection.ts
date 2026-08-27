import type { WorkflowGraph, WorkflowNode } from '../engine'
import { iterationItemTitle } from '../engine/item-title'
import type { WfRunStepDTO } from '../server/protocol'

import { NOT_RUN_STATUS } from './editor/node-renderers-shared'
import { readIterationTotal } from './run-activity-tree'

// WHAT THE RUN VIEWER IS LOOKING AT: given a selected node id and a focused
// iteration item, which node is that, which recorded step belongs to it, and
// how should the canvas be tinted.
//
// Pure, and kept out of the page because the resolution is genuinely fiddly:
// an inner-subgraph node's step is addressed by (nodeId, container, item),
// while a top-level node's is the single row with no parent — and getting that
// wrong shows the author another item's output under the node they clicked.

// A run still producing steps. `done` counts as live: the answer is in, but the
// arms that don't feed the Output are draining and their steps are still
// landing — so nothing may be called un-run yet.
const LIVE_RUN_STATUSES = new Set(['queued', 'running', 'done'])

export function isRunLive(status: string): boolean {
  return LIVE_RUN_STATUSES.has(status)
}

/**
 * Could a run of this graph have spawned child RUNS?
 *
 * True for a durable iteration (one child instance per item) or a durable
 * workflow-call (one child instance for the callee). Both `itemExecution` and
 * `calleeExecution` default to `inline`, in which case the inner work is
 * recorded as steps on this run and there is nothing to fetch.
 *
 * The point is to keep the child-runs query off the overwhelming majority of
 * runs, which can't have any. A NULL graph answers true: the version row is
 * gone, so nothing here can rule children out, and a run whose children are
 * real must not lose its drill-down because its graph was deleted.
 *
 * Only the top level is inspected. An iteration's subgraph can contain a
 * workflow-call node, but that node belongs to the ITEM's run — it would spawn
 * a grandchild, listed under the child, not here.
 */
export function canSpawnChildRuns(graph: WorkflowGraph | null): boolean {
  if (!graph) return true
  return graph.nodes.some(
    (n) =>
      (n.kind === 'iteration' && n.config.itemExecution === 'durable') ||
      (n.kind === 'workflow' && n.config.calleeExecution === 'durable'),
  )
}

/** Find a node anywhere in the graph, including inside an iteration subgraph. */
export function findNode(
  graph: WorkflowGraph,
  id: string,
): { node: WorkflowNode; parentIterationId: string | null } | null {
  for (const n of graph.nodes) {
    if (n.id === id) return { node: n, parentIterationId: null }
    if (n.kind === 'iteration') {
      const child = n.config.subgraph.nodes.find((c) => c.id === id)
      if (child) return { node: child, parentIterationId: n.id }
    }
  }
  return null
}

/**
 * The number of items an iteration node fanned out over, read from its recorded
 * step meta. 0 when the node never ran or isn't an iteration.
 */
export function iterationItemCount(step: WfRunStepDTO | null | undefined): number {
  return readIterationTotal(step?.meta) ?? 0
}

/**
 * Statuses for one iteration container's inner nodes at the focused item —
 * what actually ran for that item, plus `not-run` for the rest once the run has
 * settled. Empty when the container isn't in the graph (a version since gone).
 */
function innerStatuses(
  graph: WorkflowGraph | null,
  steps: readonly WfRunStepDTO[],
  containerId: string,
  itemIndex: number,
  settled: boolean,
): Array<[string, string]> {
  const out: Array<[string, string]> = steps
    .filter((s) => s.parentNodeId === containerId && s.itemIndex === itemIndex)
    .map((s) => [s.nodeId, s.status])
  if (!settled || !graph) return out
  const container = graph.nodes.find((n) => n.id === containerId)
  if (container?.kind !== 'iteration') return out
  const ran = new Set(out.map(([id]) => id))
  for (const n of container.config.subgraph.nodes) {
    if (n.kind === 'note' || ran.has(n.id)) continue
    out.push([n.id, NOT_RUN_STATUS])
  }
  return out
}

/**
 * nodeId → status for the top-level graph (the canvas's own nodes), driving the
 * tint + status dots. Iteration inner steps are keyed per item and layered on
 * separately (see `resolveRunSelection`) so they don't collide here.
 *
 * Once the run has SETTLED, every top-level node still missing a step is marked
 * `not-run` so the canvas dims it. Absence of a step is the only evidence
 * either way, and it covers both reasons a node goes untouched — an arm a
 * branch routed away from, and a node with no live path into it at all. Gated
 * on settled because until then "no step" means "not yet", and dimming the
 * whole graph at run start would say the opposite of what it means.
 */
export function topLevelStatuses(
  graph: WorkflowGraph | null | undefined,
  steps: readonly WfRunStepDTO[],
  runStatus: string | undefined,
): Map<string, string> {
  const map = new Map(
    steps.filter((s) => !s.parentNodeId).map((s) => [s.nodeId, s.status]),
  )
  if (graph && runStatus && !isRunLive(runStatus)) {
    for (const n of graph.nodes) {
      // A Note is a canvas annotation, never executed — dimming it would
      // report a non-event.
      if (n.kind === 'note' || map.has(n.id)) continue
      map.set(n.id, NOT_RUN_STATUS)
    }
  }
  return map
}

export type RunSelection = {
  selectedNode: WorkflowNode | null
  parentIterationId: string | null
  /** The focused item, clamped to the relevant iteration's actual count. */
  itemIndex: number
  itemCount: number
  /**
   * What the focused item is CALLED, from the container's `itemTitle` template
   * resolved against that item's own value. Null when the author set no
   * template, when it resolves to nothing, or when the item's value isn't on
   * this run — a DURABLE item's value lives on its own child run, and the
   * picker this feeds only ever appears for inline items anyway.
   */
  itemTitle: string | null
  selectedStep: WfRunStepDTO | null
  canvasStatuses: Map<string, string>
}

export function resolveRunSelection(input: {
  graph: WorkflowGraph | null
  steps: WfRunStepDTO[]
  runStatus: string
  selectedId: string | null
  /** The author's raw item pick, before clamping. */
  selectedItemIndex: number
  topLevel: Map<string, string>
}): RunSelection {
  const { graph, steps, runStatus, selectedId, selectedItemIndex, topLevel } = input

  const found = selectedId && graph ? findNode(graph, selectedId) : null
  const selectedNode = found?.node ?? null
  const parentIterationId = found?.parentIterationId ?? null

  // How many items the relevant iteration fanned out over — for the container's
  // own aggregate step when it's selected, or the parent container's step when
  // an inner node is selected. Drives the per-item picker + the itemIndex clamp.
  const iterationId =
    parentIterationId ?? (selectedNode?.kind === 'iteration' ? selectedId : null)
  const iterationStep = iterationId
    ? (steps.find((s) => s.nodeId === iterationId && !s.parentNodeId) ?? null)
    : null
  const itemCount = iterationItemCount(iterationStep)
  // Clamped at READ time, so a pick survives switching between iterations of
  // different lengths without needing a reset.
  const itemIndex = itemCount > 0 ? Math.min(selectedItemIndex, itemCount - 1) : 0

  // An inner-subgraph node's step is addressed by (nodeId, container, item);
  // a top-level node's step is the single row with no parent.
  const selectedStep = !selectedId
    ? null
    : parentIterationId
      ? (steps.find(
          (s) =>
            s.nodeId === selectedId &&
            s.parentNodeId === parentIterationId &&
            s.itemIndex === itemIndex,
        ) ?? null)
      : (steps.find((s) => s.nodeId === selectedId && !s.parentNodeId) ?? null)

  // The focused item's name, from its own trigger step — whose output IS the
  // item. Resolved live rather than read from anywhere: every step of an inline
  // item is already on this run, so the value is in hand, and nothing had to be
  // stored for runs recorded before titles existed.
  const container = iterationId && graph ? findNode(graph, iterationId) : null
  const titleTemplate =
    container?.node.kind === 'iteration' ? container.node.config.itemTitle : ''
  const itemTitle = !titleTemplate?.trim()
    ? null
    : iterationItemTitle(
        titleTemplate,
        steps.find(
          (s) =>
            s.parentNodeId === iterationId &&
            s.itemIndex === itemIndex &&
            s.nodeKind === 'trigger',
        )?.output,
        { index: itemIndex, total: itemCount },
      )

  // Canvas tint: top-level statuses, plus — when an iteration or one of its
  // inner nodes is selected — that iteration's inner nodes tinted by the focused
  // item, so stepping through items lights up the subgraph item by item.
  //
  // The inner nodes of a container get `not-run` only while that container
  // is FOCUSED, because only then are we layering an item's steps and can
  // tell "didn't run for this item" from "no item selected". Blanket-
  // dimming every subgraph would mark a perfectly successful loop as
  // un-run until you clicked into it.
  const canvasStatuses = iterationId
    ? new Map<string, string>([
        ...topLevel,
        ...innerStatuses(
          graph,
          steps,
          iterationId,
          itemIndex,
          !isRunLive(runStatus),
        ),
      ])
    : topLevel

  return {
    selectedNode,
    parentIterationId,
    itemIndex,
    itemCount,
    itemTitle,
    selectedStep,
    canvasStatuses,
  }
}
