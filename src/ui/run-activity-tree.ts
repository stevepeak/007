import type { WorkflowGraph, WorkflowNode } from '../engine'
import { NON_STEP_KINDS, TERMINAL_STEP_STATUSES } from '../engine/run-progress'
import { RUN_STATE_LEVEL } from '../engine/stream-sink'
import type { WfRunLogDTO, WfRunStepDTO } from '../server/protocol'

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
const MANY_ITEMS = 4

const BOOKEND_LEVELS = new Set(['node-start', 'node-end'])

function deriveStatus(step?: WfRunStepDTO | null): ActivityStatus {
  if (!step) return 'pending'
  if (step.status === 'running') return 'running'
  if (TERMINAL_STEP_STATUSES.has(step.status))
    return step.status as ActivityStatus
  return 'pending'
}

function resolveDuration(
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
function rollUp(children: ActivityRow[]): ActivityStatus {
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

function iterationTotal(step: WfRunStepDTO | null | undefined): number | null {
  return readIterationTotal(step?.meta)
}

// The run status a lifecycle marker carries, from its `{ status }` meta.
function readStateStatus(meta: unknown): string | null {
  const status = (meta as { status?: unknown } | null)?.status
  return typeof status === 'string' ? status : null
}

// How many nodes were still running when the marker was written. Absent on
// every marker but `done`, and on rows written before the field existed.
function readPendingNodes(meta: unknown): number | null {
  const n = (meta as { pendingNodes?: unknown } | null)?.pendingNodes
  return typeof n === 'number' ? n : null
}

export function buildActivityTree(input: {
  graph: WorkflowGraph | null
  steps: WfRunStepDTO[]
  logs: WfRunLogDTO[]
  live?: boolean
}): ActivityTopRow[] {
  const { graph, steps, logs, live = false } = input

  // --- Index steps: latest top-level step per node + children by container. ---
  const topSteps = new Map<string, WfRunStepDTO>()
  const childSteps = new Map<string, WfRunStepDTO[]>()
  for (const s of steps) {
    if (s.parentNodeId == null) {
      const prev = topSteps.get(s.nodeId)
      if (!prev || s.sequence >= prev.sequence) topSteps.set(s.nodeId, s)
    } else {
      const arr = childSteps.get(s.parentNodeId) ?? []
      arr.push(s)
      childSteps.set(s.parentNodeId, arr)
    }
  }

  // --- Index logs by node (bookends → timing; the rest → leaf lines). ---
  const logsByNode = new Map<string, WfRunLogDTO[]>()
  const rawTiming = new Map<string, { start?: number; end?: number }>()
  for (const l of logs) {
    if (l.nodeId == null) continue
    if (BOOKEND_LEVELS.has(l.level)) {
      const t = rawTiming.get(l.nodeId) ?? {}
      if (l.level === 'node-start') t.start = l.ts
      else t.end = l.ts
      rawTiming.set(l.nodeId, t)
      continue
    }
    const arr = logsByNode.get(l.nodeId) ?? []
    arr.push(l)
    logsByNode.set(l.nodeId, arr)
  }
  for (const arr of logsByNode.values())
    arr.sort((a, b) => a.ts - b.ts || (a.sequence ?? 0) - (b.sequence ?? 0))

  const timingFor = (
    nodeId: string,
  ): { start: number; end: number } | undefined => {
    const t = rawTiming.get(nodeId)
    return t?.start != null && t?.end != null
      ? { start: t.start, end: t.end }
      : undefined
  }

  const logLeaves = (nodeId: string, keyPrefix: string): ActivityLogRow[] =>
    (logsByNode.get(nodeId) ?? []).map((l, i) => ({
      kind: 'log',
      key: `${keyPrefix}:log:${l.ts}:${l.sequence ?? 0}:${i}`,
      level: l.level,
      message: l.message,
      ts: l.ts,
    }))

  // --- Iteration container → one group row per item, inner nodes beneath. ---
  const iterationChildren = (
    containerId: string,
    node: WorkflowNode | undefined,
    containerStep: WfRunStepDTO | null | undefined,
  ): ActivityGroupRow[] => {
    const kids = (childSteps.get(containerId) ?? []).filter(
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
  const subAgentChildren = (containerId: string): ActivityNodeRow[] =>
    (childSteps.get(containerId) ?? [])
      .filter((s) => s.nodeId.startsWith('sub:'))
      .sort((a, b) => (a.itemIndex ?? 0) - (b.itemIndex ?? 0))
      .map((s) => {
        const ord = s.itemIndex ?? 0
        const name = (s.meta as { subAgentName?: string } | null)?.subAgentName
        const children = logLeaves(s.nodeId, `${containerId}:sub:${ord}`)
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

  const makeTopRow = (
    nodeId: string,
    node: WorkflowNode | undefined,
    step: WfRunStepDTO | null | undefined,
  ): ActivityNodeRow => {
    const status = deriveStatus(step)
    const nodeKind = node?.kind ?? step?.nodeKind ?? 'node'
    let children: ActivityRow[]
    let itemsDone: number | null = null
    let itemsTotal: number | null = null
    if (nodeKind === 'iteration') {
      const groups = iterationChildren(nodeId, node, step)
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
      children = [...subAgentChildren(nodeId), ...logLeaves(nodeId, nodeId)]
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
      durationMs: resolveDuration(step, timingFor(nodeId)),
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

  // --- Run lifecycle markers, from the node-less entries in the feed. ---
  const stateLogs = logs
    .filter((l) => l.level === RUN_STATE_LEVEL)
    .sort((a, b) => a.ts - b.ts)
  // The run's t0, for the elapsed each later marker reports.
  const runStartTs =
    stateLogs.find((l) => readStateStatus(l.meta) === 'running')?.ts ?? null
  const stateRows: ActivityStateRow[] = stateLogs.map((l) => {
    const status = readStateStatus(l.meta) ?? 'running'
    return {
      kind: 'state' as const,
      key: `state:${status}`,
      status,
      message: l.message,
      ts: l.ts,
      elapsedMs:
        runStartTs != null && status !== 'queued' && l.ts >= runStartTs
          ? l.ts - runStartTs
          : null,
      pendingNodes: readPendingNodes(l.meta),
    }
  })

  // Most markers have a DEFINED position, not a computed one. `queued` and
  // `running` precede all node work by definition, and the terminal three
  // follow all of it, so they are pinned rather than placed by timestamp.
  //
  // Pinning is also the only reliable option: `wf_run_step.started_at` is a
  // `mode: 'timestamp'` column and therefore truncated to whole SECONDS, while
  // a marker's `ts` is exact millis. Comparing the two inside a single second
  // is a coin flip — which is precisely where `queued` and `running` land, so
  // they were sorting after the first nodes.
  //
  // `done` is the one marker that genuinely falls among the rows: the whole
  // point is seeing which nodes were still running when the answer went out.
  const pinnedRank = (status: string): number =>
    status === 'queued' ? 0 : status === 'running' ? 1 : 2
  const leading = stateRows
    .filter((r) => r.status === 'queued' || r.status === 'running')
    .sort((a, b) => pinnedRank(a.status) - pinnedRank(b.status))
  const trailing = stateRows.filter(
    (r) =>
      r.status === 'completed' ||
      r.status === 'failed' ||
      r.status === 'cancelled',
  )
  const floating = stateRows.filter(
    (r) => !leading.includes(r) && !trailing.includes(r),
  )

  // When a top-level node row STARTED, for placing the floating markers among
  // them. Falls back to the node-start bookend, then to +Infinity for a node
  // that never ran — so a marker lands before the nodes an early branch
  // skipped rather than after them.
  const startTsOf = (nodeId: string, step?: WfRunStepDTO | null): number =>
    step?.startedAt ?? timingFor(nodeId)?.start ?? Infinity

  // Second granularity on both sides, since that is all `started_at` carries.
  const toSeconds = (ms: number): number =>
    Number.isFinite(ms) ? Math.floor(ms / 1000) : ms

  // Place the floating markers WITHOUT reordering the nodes: walk the ordered
  // nodes and flush every marker at or before each one's start. Node ordering
  // stays sequence-driven, exactly as before.
  const interleave = (
    nodes: Array<{ row: ActivityNodeRow; startTs: number }>,
  ): ActivityTopRow[] => {
    const out: ActivityTopRow[] = [...leading]
    let s = 0
    for (const n of nodes) {
      while (
        s < floating.length &&
        toSeconds(floating[s].ts) <= toSeconds(n.startTs)
      ) {
        out.push(floating[s++])
      }
      out.push(n.row)
    }
    while (s < floating.length) out.push(floating[s++])
    out.push(...trailing)
    return out
  }

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
          row: makeTopRow(n.id, n, topSteps.get(n.id)),
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
        row: makeTopRow(s.nodeId, undefined, s),
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
