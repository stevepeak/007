import { TERMINAL_STEP_STATUSES } from '../engine/run-progress'
import type { WfRunStepDTO } from '../server/protocol'

// The SHAPE of the run activity feed: the row union it renders, the status
// vocabulary, and the small derivations every phase of the build needs.
//
// Its own module so the three build phases — index, rows, tree — can all depend
// on it without depending on each other.

export type ActivityStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'pending'

// A row that maps to a selectable graph node (top-level, iteration-inner, or a
// sub-agent delegation). `selectNodeId` is what to pass to `onSelectNode` on
// click — the same as `nodeId` except for sub-agent rows, whose synthetic
// `sub:` id has no graph node, so they select their parent agent instead.
export type ActivityNodeRow = {
  kind: 'node'
  key: string
  nodeId: string
  selectNodeId: string
  parentIterationId: string | null
  itemIndex: number | null
  nodeKind: string
  label: string
  status: ActivityStatus
  durationMs: number | null
  /** Derived USD cost of this node's step — shown on agent rows; null otherwise. */
  costUsd: number | null
  /** Iteration only: items reached a terminal state / total items (e.g. 5/10). */
  itemsDone: number | null
  itemsTotal: number | null
  error: string | null
  expandable: boolean
  defaultOpen: boolean
  children: ActivityRow[]
}

// A synthetic grouping row for one iteration item ("Item k / N"). Selecting it
// focuses the container node at that item index (via the dock's item picker).
export type ActivityGroupRow = {
  kind: 'group'
  key: string
  label: string
  containerNodeId: string
  itemIndex: number
  status: ActivityStatus
  expandable: true
  defaultOpen: boolean
  children: ActivityRow[]
}

// A leaf: a thinking / tool / info / warn / error log line under its node. Node
// bookends (`node-start` / `node-end`) never become leaves — they become the
// node row itself.
export type ActivityLogRow = {
  kind: 'log'
  key: string
  level: string
  message: string
  ts: number
}

// A run-level lifecycle marker — queued / started / answer delivered / settled
// / failed. Not a graph node: it sits BETWEEN node rows at the moment it
// happened, which is the only way to see, say, that the answer was delivered
// while three nodes were still running.
export type ActivityStateRow = {
  kind: 'state'
  key: string
  /** The run status this marks (`WF_RUN_STATUSES`). */
  status: string
  /** The engine's plain-text line, rendered when nothing richer is derivable. */
  message: string
  ts: number
  /**
   * Wall-clock from the run STARTING to this marker. Timed off the `running`
   * marker rather than the run row, so the tree stays a pure function of the
   * feed. Null on `queued`, and on runs recorded before markers existed.
   */
  elapsedMs: number | null
  /** Nodes still executing behind the answer — `done` markers only. */
  pendingNodes: number | null
}

export type ActivityRow = ActivityNodeRow | ActivityGroupRow | ActivityLogRow

/** A row at the top level of the tree: a graph node, or a lifecycle marker. */
export type ActivityTopRow = ActivityNodeRow | ActivityStateRow

// A tree row flattened for rendering: carries its indent `depth` and resolved
// expand state so the view is a single `.map`, not a recursive component tree.
export type FlatRow = {
  row: ActivityRow | ActivityStateRow
  depth: number
  expanded: boolean
  hasChildren: boolean
}

// Item-count threshold above which completed iteration items collapse by
// default (a 40-item loop shouldn't flood the feed); small loops stay open.
export const MANY_ITEMS = 4


export function deriveStatus(step?: WfRunStepDTO | null): ActivityStatus {
  if (!step) return 'pending'
  if (step.status === 'running') return 'running'
  if (TERMINAL_STEP_STATUSES.has(step.status))
    return step.status as ActivityStatus
  return 'pending'
}

export function resolveDuration(
  step: WfRunStepDTO | null | undefined,
  timing: { start: number; end: number } | undefined,
): number | null {
  if (
    step?.startedAt != null &&
    step?.finishedAt != null &&
    step.finishedAt >= step.startedAt
  )
    return step.finishedAt - step.startedAt
  if (timing && timing.end >= timing.start) return timing.end - timing.start
  return null
}

// Roll a container's status up from its children: any failure wins, then any
// still-running, then all-terminal → completed, else pending.
export function rollUp(children: ActivityRow[]): ActivityStatus {
  const nodes = children.filter(
    (c): c is ActivityNodeRow | ActivityGroupRow => c.kind !== 'log',
  )
  if (nodes.some((c) => c.status === 'failed')) return 'failed'
  if (nodes.some((c) => c.status === 'running')) return 'running'
  if (
    nodes.length > 0 &&
    nodes.every((c) => c.status === 'completed' || c.status === 'skipped')
  )
    return 'completed'
  return 'pending'
}

// The recorded meta on an iteration node's step: how many items it fanned out
// over, each item's terminal status, and the loop's concurrency / stop-on-error
// settings. The untyped `meta` JSON column is narrowed through the two guards
// below — shared by every reader (activity tree, run page, run log) so the shape
// knowledge lives in one place.
export type IterationMeta = {
  total: number
  concurrency: number
  stopOnError: boolean
  /** The fan-out bound this run was held to. Optional: steps recorded before the
   * bound existed have none, and their meta still has to read. */
  limit?: number
  items: Array<{ index: number; status: string; error?: string }>
}

// Loose read: just the item count. A still-running loop reports `total` before
// its `items` array is populated, so this only requires `total`. null when
// absent or the step isn't an iteration.
export function readIterationTotal(meta: unknown): number | null {
  const total = (meta as { total?: unknown } | null)?.total
  return typeof total === 'number' ? total : null
}

// Strict read: the full per-item meta, available once the engine has recorded
// the `items` array — used to render the per-item trace. null until then.
export function readIterationMeta(meta: unknown): IterationMeta | null {
  if (
    meta &&
    typeof meta === 'object' &&
    Array.isArray((meta as { items?: unknown }).items) &&
    typeof (meta as { total?: unknown }).total === 'number'
  ) {
    return meta as IterationMeta
  }
  return null
}

export function iterationTotal(step: WfRunStepDTO | null | undefined): number | null {
  return readIterationTotal(step?.meta)
}
