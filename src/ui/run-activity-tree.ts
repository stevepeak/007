import type { WorkflowGraph } from '../engine'
import { NON_STEP_KINDS } from '../engine/run-progress'
import type {
  WfRunLogDTO,
  WfRunStepDTO,
  WfRunSummary,
} from '../server/protocol'

import { indexRunActivity } from './run-activity-index'
import type {
  ActivityNodeRow,
  ActivityRow,
  ActivityStateRow,
  ActivityTopRow,
  FlatRow,
} from './run-activity-model'
import { makeTopRow } from './run-activity-rows'
import { buildStateRows, interleaveStateRows } from './run-activity-state-rows'

// Pure derivation for the run viewer's "Activity" tree — the living,
// tree-shaped replacement for the old flat log stream. Sits beside the UI (no
// JSX) so it can be unit-tested, mirroring how `engine/run-progress.ts` is a
// pure sibling of the run-viewer progress bar.
//
// The tree's SKELETON comes from recorded steps (`WfRunStepDTO`), which carry
// the parent/item hierarchy the flat log feed lacks: an iteration's per-item
// sub-nodes (`parentNodeId` = container, `itemIndex` = item) and an agent's
// delegated sub-agent runs (`nodeId` = `sub:<agent>:<ordinal>`). The graph
// supplies labels/kinds and lets not-yet-run nodes show as faint "pending"
// rows. Logs (thinking / tool / info lines) hang off their owning node as leaf
// activity.
//
// Steps only reach as far as this run, though. A DURABLE iteration item and a
// durable workflow-call callee execute as their own workflow instances, so
// their inner nodes are steps on a different run entirely — nothing in this
// run's step trace would show them, and the loop would read as a black box.
// `childRuns` closes that: one row per child run, sourced from
// `wf_run.parent_run_id`, which is written at SPAWN time and so populates the
// list while the children are still working rather than once the loop settles.

export type {
  ActivityGroupRow,
  ActivityLogRow,
  ActivityNodeRow,
  ActivityRow,
  ActivityStateRow,
  ActivityStatus,
  ActivityTopRow,
  FlatRow,
  IterationMeta,
} from './run-activity-model'
export { readIterationMeta, readIterationTotal } from './run-activity-model'

export function buildActivityTree(input: {
  graph: WorkflowGraph | null
  steps: WfRunStepDTO[]
  logs: WfRunLogDTO[]
  /** The runs this run spawned — durable iteration items and callees. */
  childRuns?: WfRunSummary[]
  live?: boolean
}): ActivityTopRow[] {
  const { graph, steps, logs, childRuns = [], live = false } = input

  const index = indexRunActivity(steps, logs, childRuns)
  const { topSteps, timingFor } = index

  const placement = buildStateRows(logs)

  // When a top-level node row STARTED, for placing the floating markers among
  // them. Falls back to the node-start bookend, then to +Infinity for a node
  // that never ran — so a marker lands before the nodes an early branch
  // skipped rather than after them.
  const startTsOf = (nodeId: string, step?: WfRunStepDTO | null): number =>
    step?.startedAt ?? timingFor(nodeId)?.start ?? Infinity

  const interleave = (nodes: Array<{ row: ActivityNodeRow; startTs: number }>) =>
    interleaveStateRows(nodes, placement)

  // --- Top-level ordering: graph order, refined by executed sequence. ---
  if (graph) {
    return interleave(
      graph.nodes
        .filter((n) => !NON_STEP_KINDS.has(n.kind))
        .map((n, i) => ({ n, i }))
        .sort((a, b) => {
          const sa = topSteps.get(a.n.id)?.sequence ?? Infinity
          const sb = topSteps.get(b.n.id)?.sequence ?? Infinity
          return sa - sb || a.i - b.i
        })
        .map(({ n }) => ({
          row: makeTopRow(index, n.id, n, topSteps.get(n.id), live),
          startTs: startTsOf(n.id, topSteps.get(n.id)),
        })),
    )
  }

  // Null graph (version gone): build from recorded steps alone.
  return interleave(
    [...topSteps.values()]
      .filter((s) => !NON_STEP_KINDS.has(s.nodeKind))
      .sort((a, b) => a.sequence - b.sequence)
      .map((s) => ({
        row: makeTopRow(index, s.nodeId, undefined, s, live),
        startTs: startTsOf(s.nodeId, s),
      })),
  )
}

// Walk the tree depth-first into an ordered render list, honoring per-key
// expand overrides (falling back to each row's `defaultOpen`). Overrides are
// keyed by stable identity strings, so user toggles survive each poll refresh.
export function flattenTree(
  rows: ActivityTopRow[],
  overrides: Map<string, 'open' | 'closed'>,
): FlatRow[] {
  const out: FlatRow[] = []
  const walk = (row: ActivityRow | ActivityStateRow, depth: number) => {
    if (row.kind === 'log' || row.kind === 'state') {
      out.push({ row, depth, expanded: false, hasChildren: false })
      return
    }
    const hasChildren = row.children.length > 0
    const ov = overrides.get(row.key)
    const expanded =
      hasChildren && (ov ? ov === 'open' : row.defaultOpen)
    out.push({ row, depth, expanded, hasChildren })
    if (expanded) for (const c of row.children) walk(c, depth + 1)
  }
  for (const r of rows) walk(r, 0)
  return out
}
