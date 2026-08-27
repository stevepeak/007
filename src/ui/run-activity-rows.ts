import type { WorkflowNode } from '../engine'
import { iterationItemListLabel, iterationItemTitle } from '../engine/item-title'
import { NON_STEP_KINDS } from '../engine/run-progress'
import type { WfRunStepDTO, WfRunSummary } from '../server/protocol'

import type { RunActivityIndex } from './run-activity-index'
import {
  deriveStatus,
  iterationTotal,
  MANY_ITEMS,
  resolveDuration,
  rollUp,
  type ActivityGroupRow,
  type ActivityStatus,
  type ActivityLogRow,
  type ActivityNodeRow,
  type ActivityRow,
} from './run-activity-model'

// Turning the indexed run into ROWS. One function per shape the feed can take:
// a node's own log lines, an iteration container's per-item groups, an agent's
// delegated sub-runs, and the top-level row that folds those together.
//
// Each takes the index rather than closing over it, so they read (and test) as
// plain functions of "given this run, what does this node look like?".

/** A node's feed lines, as leaf rows beneath it. */
export function logLeaves(
  index: RunActivityIndex,
  nodeId: string,
  keyPrefix: string,
): ActivityLogRow[] {
  return (index.logsByNode.get(nodeId) ?? []).map((l, i) => ({
    kind: 'log',
    key: `${keyPrefix}:log:${l.ts}:${l.sequence ?? 0}:${i}`,
    level: l.level,
    message: l.message,
    ts: l.ts,
  }))
}

// --- Iteration container → one group row per item, inner nodes beneath. ---
function iterationChildren(
  index: RunActivityIndex,
  containerId: string,
  node: WorkflowNode | undefined,
  containerStep: WfRunStepDTO | null | undefined,
): ActivityGroupRow[] {
  const kids = (index.childSteps.get(containerId) ?? []).filter(
    (s) => !NON_STEP_KINDS.has(s.nodeKind),
  )
  if (kids.length === 0) return []

  const subNodes =
    node?.kind === 'iteration'
      ? new Map(node.config.subgraph.nodes.map((n) => [n.id, n]))
      : new Map<string, WorkflowNode>()

  // An INLINE item's title is resolved right here, from the item's own trigger
  // step — whose output IS the item. Nothing is stored for it, unlike a durable
  // item (see `wf_run.item_title`): all of this item's steps are already on
  // this run, so the value the template needs is in hand, and resolving live
  // means the feature also works on runs recorded before it existed.
  const titleTemplate =
    node?.kind === 'iteration' ? node.config.itemTitle : undefined
  const itemValues = new Map<number, unknown>()
  if (titleTemplate?.trim()) {
    for (const s of index.childSteps.get(containerId) ?? []) {
      if (s.nodeKind === 'trigger') itemValues.set(s.itemIndex ?? 0, s.output)
    }
  }

  const byItem = new Map<number, WfRunStepDTO[]>()
  for (const s of kids) {
    const idx = s.itemIndex ?? 0
    const arr = byItem.get(idx) ?? []
    arr.push(s)
    byItem.set(idx, arr)
  }

  const total =
    iterationTotal(containerStep) ?? Math.max(...byItem.keys()) + 1
  const many = total > MANY_ITEMS

  return [...byItem.keys()]
    .sort((a, b) => a - b)
    .map((idx) => {
      const itemSteps = byItem
        .get(idx)!
        .sort((a, b) => a.sequence - b.sequence)
      const children: ActivityNodeRow[] = itemSteps.map((s) => {
        const inner = subNodes.get(s.nodeId)
        return {
          kind: 'node',
          key: `${containerId}:${idx}:${s.nodeId}`,
          nodeId: s.nodeId,
          selectNodeId: s.nodeId,
          parentIterationId: containerId,
          itemIndex: idx,
          nodeKind: s.nodeKind,
          label: inner?.label ?? s.nodeId,
          status: deriveStatus(s),
          durationMs: resolveDuration(s, undefined),
          costUsd: s.costUsd,
          itemsDone: null,
          itemsTotal: null,
          error: s.error,
          expandable: false,
          defaultOpen: false,
          children: [],
        }
      })
      const status = rollUp(children)
      return {
        kind: 'group',
        key: `${containerId}:item:${idx}`,
        label: iterationItemListLabel(
          iterationItemTitle(titleTemplate, itemValues.get(idx), {
            index: idx,
            total,
          }),
          idx,
          total,
        ),
        containerNodeId: containerId,
        itemIndex: idx,
        status,
        // An inline item's whole trace is right here, so there is nothing to
        // open — and no separate run, timing or cost of its own to report.
        childRunId: null,
        durationMs: null,
        costUsd: null,
        error: null,
        expandable: true,
        // Keep the active/failed item open; open completed items only when
        // the loop is small enough not to flood the feed.
        defaultOpen: status === 'running' || status === 'failed' || !many,
        children,
      }
    })
}

/**
 * Map a child RUN's status onto the feed's node-status vocabulary.
 *
 * `done` reads as running on purpose: the run's answer has landed but arms that
 * don't feed its Output are still draining, and calling that finished is the
 * exact confusion the run lifecycle markers exist to clear up. `queued` reads
 * as pending — the child exists but has not started.
 */
function runStatusToActivity(status: string): ActivityStatus {
  switch (status) {
    case 'queued':
      return 'pending'
    case 'running':
    case 'done':
      return 'running'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'skipped'
    default:
      return 'completed'
  }
}

function runDuration(run: WfRunSummary): number | null {
  const start = run.startedAt ?? run.createdAt
  // Only a CLOSED window counts, matching `timingFor` — pairing a start with
  // `now` would make every in-flight child look like it finished instantly.
  return run.finishedAt != null && run.finishedAt >= start
    ? run.finishedAt - start
    : null
}

// --- Durable items / callees → one group row per CHILD RUN. ---
//
// The other half of `iterationChildren`. A durable item's inner nodes were
// never recorded against this run — they are steps on the child's own run — so
// the row is built from the child run row itself and links there rather than
// expanding. Crucially this reads `wf_run`, which is written at SPAWN time, so
// items appear the moment they are created rather than when the loop settles.
function childRunGroups(
  index: RunActivityIndex,
  containerNodeId: string,
  containerStep: WfRunStepDTO | null | undefined,
): ActivityGroupRow[] {
  const runs = index.childRuns.get(containerNodeId) ?? []
  if (runs.length === 0) return []
  // Ordered here rather than relying on the server's ORDER BY: this is a pure
  // derivation, and item order is what the reader uses to find "the one that
  // failed" — it must not depend on the shape of the caller's fetch. Ties
  // (callee rows, which all sit at a null index) keep arrival order.
  const ordered = runs
    .map((run, i) => ({ run, i }))
    .sort(
      (a, b) =>
        (a.run.parent?.itemIndex ?? -1) - (b.run.parent?.itemIndex ?? -1) ||
        a.i - b.i,
    )
    .map(({ run }) => run)
  // The declared item count once the loop has resolved its list; until then the
  // children spawned so far are all we know of — so a loop mid-fan-out reads
  // "Item 2 / 3" rather than "Item 2 / 2".
  const total = iterationTotal(containerStep) ?? runs.length
  return ordered.map((run) => {
    const itemIndex = run.parent?.itemIndex ?? null
    return {
      kind: 'group' as const,
      // Keyed on the child RUN id rather than the position, so the key is
      // unique even for callee rows, which all sit at a null index.
      key: `${containerNodeId}:run:${run.id}`,
      label:
        itemIndex == null
          ? // A callee has no position — its workflow name is the informative
            // thing about it.
            run.workflowName
          : // Resolved at SPAWN time and stored on the child, because this row
            // is built from `wf_run` alone — the item's value lives in the
            // child's own trigger step, which the parent never reads.
            iterationItemListLabel(run.parent?.itemTitle, itemIndex, total),
      containerNodeId,
      itemIndex,
      status: runStatusToActivity(run.status),
      childRunId: run.id,
      durationMs: runDuration(run),
      costUsd: run.costUsd,
      error: run.error,
      // Nothing to expand: none of this item's work happened on this run.
      expandable: false,
      defaultOpen: false,
      children: [],
    }
  })
}

// --- Agent delegations (`sub:<agent>:<ord>`) → flat rows under the agent. ---
function subAgentChildren(
  index: RunActivityIndex,
  containerId: string,
): ActivityNodeRow[] {
  return (index.childSteps.get(containerId) ?? [])
    .filter((s) => s.nodeId.startsWith('sub:'))
    .sort((a, b) => (a.itemIndex ?? 0) - (b.itemIndex ?? 0))
    .map((s) => {
      const ord = s.itemIndex ?? 0
      const name = (s.meta as { subAgentName?: string } | null)?.subAgentName
      const children = logLeaves(index, s.nodeId, `${containerId}:sub:${ord}`)
      return {
        kind: 'node',
        key: `${containerId}:sub:${ord}`,
        nodeId: s.nodeId,
        // Sub-agent ids aren't in the graph — clicking selects the parent.
        selectNodeId: containerId,
        parentIterationId: null,
        itemIndex: null,
        nodeKind: 'agent',
        label: name ? `⇢ ${name}` : `Delegated run ${ord + 1}`,
        status: deriveStatus(s),
        durationMs: resolveDuration(s, undefined),
        costUsd: s.costUsd,
        itemsDone: null,
        itemsTotal: null,
        error: s.error,
        expandable: children.length > 0,
        defaultOpen: true,
        children,
      }
    })
}

export function makeTopRow(
  index: RunActivityIndex,
  nodeId: string,
  node: WorkflowNode | undefined,
  step: WfRunStepDTO | null | undefined,
  live: boolean,
): ActivityNodeRow {
  const status = deriveStatus(step)
  const nodeKind = node?.kind ?? step?.nodeKind ?? 'node'
  // The runs this node spawned, if any. A node is EITHER inline (its inner work
  // is steps on this run) or durable (its inner work is a child run), never
  // both, so these two never compete for the same node — but reading the child
  // runs first means a durable loop shows its items from the moment they are
  // spawned, before it has recorded a step of its own.
  const spawned = childRunGroups(index, nodeId, step)
  let children: ActivityRow[]
  let itemsDone: number | null = null
  let itemsTotal: number | null = null
  if (nodeKind === 'iteration') {
    const groups = spawned.length > 0 ? spawned : iterationChildren(index, nodeId, node, step)
    children = groups
    itemsTotal = iterationTotal(step) ?? (groups.length || null)
    itemsDone = groups.filter((g) => g.status !== 'running' && g.status !== 'pending').length
    // A running loop that hasn't recorded any item yet shouldn't look stalled.
    if (children.length === 0 && status === 'running' && live) {
      const total = iterationTotal(step)
      children = [
        {
          kind: 'log',
          key: `${nodeId}:preparing`,
          level: 'info',
          message: total
            ? `Preparing ${total} item${total === 1 ? '' : 's'}…`
            : 'Preparing items…',
          ts: step?.startedAt ?? 0,
        },
      ]
    }
  } else {
    // A durable workflow-call node spawns exactly one child run. Same row shape
    // as a durable iteration item, and the same reason it exists: the callee's
    // trace is on its own run, so this is the link to it. An INLINE callee has
    // no child run and nothing changes here.
    children = [
      ...spawned,
      ...subAgentChildren(index, nodeId),
      ...logLeaves(index, nodeId, nodeId),
    ]
  }
  return {
    kind: 'node',
    key: nodeId,
    nodeId,
    selectNodeId: nodeId,
    parentIterationId: null,
    itemIndex: null,
    nodeKind,
    label: node?.label ?? nodeId,
    status,
    durationMs: resolveDuration(step, index.timingFor(nodeId)),
    costUsd: step?.costUsd ?? null,
    itemsDone,
    itemsTotal,
    error: step?.error ?? null,
    expandable: children.length > 0,
    // Loops collapse once done; every other node stays open to show its feed.
    defaultOpen:
      nodeKind === 'iteration'
        ? status === 'running' || status === 'failed'
        : true,
    children,
  }
}
