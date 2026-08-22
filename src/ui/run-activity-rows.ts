import type { WorkflowNode } from '../engine'
import { NON_STEP_KINDS } from '../engine/run-progress'
import type { WfRunStepDTO } from '../server/protocol'

import type { RunActivityIndex } from './run-activity-index'
import {
  deriveStatus,
  iterationTotal,
  MANY_ITEMS,
  resolveDuration,
  rollUp,
  type ActivityGroupRow,
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
        label: `Item ${idx + 1} / ${total}`,
        containerNodeId: containerId,
        itemIndex: idx,
        status,
        expandable: true,
        // Keep the active/failed item open; open completed items only when
        // the loop is small enough not to flood the feed.
        defaultOpen: status === 'running' || status === 'failed' || !many,
        children,
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
  let children: ActivityRow[]
  let itemsDone: number | null = null
  let itemsTotal: number | null = null
  if (nodeKind === 'iteration') {
    const groups = iterationChildren(index, nodeId, node, step)
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
    children = [...subAgentChildren(index, nodeId), ...logLeaves(index, nodeId, nodeId)]
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
