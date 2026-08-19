import type { WorkflowGraph } from './graph'

// ---------------------------------------------------------------------------
// Run progress — a coarse, host-facing summary of "where is this run right now"
// (the currently-active node + a completed/total bar), derived purely from the
// graph shape and the recorded step trace. No DB, no Cloudflare: the storage
// layer loads the rows and calls this, and the run-viewer UI calls it directly
// on the already-fetched `getRun` payload. Deliberately transport-agnostic: if a
// live push subscriber is ever built it can derive the same shape from streamed
// `wf_run_step`/status events without touching this. (The RunRoom WebSocket that
// once stood in for that subscriber was removed in ART-25 — it had no client.
// See `docs/chat-latency/02-push-transport.md`.)
// ---------------------------------------------------------------------------

// Structural bookends / annotations that never execute as a run step, so they
// don't count toward the progress denominator (see graph-schema baseNode: the
// trigger/output/note nodes "never run as steps").
export const NON_STEP_KINDS = new Set([
  'trigger',
  'note',
  'output',
  'feature-request',
])

// Step statuses that mean a node is done (any which way).
export const TERMINAL_STEP_STATUSES = new Set(['completed', 'failed', 'skipped'])

// Run statuses that mean the run is finished as far as a progress bar is
// concerned — it pins to 100%.
//
// `done` counts. The Output was reached and the answer is final; what remains
// is background arms draining, which nobody is waiting on. Leaving it out left
// a finished answer sitting under a bar that still read "working".
const TERMINAL_RUN_STATUSES = new Set([
  'done',
  'completed',
  'failed',
  'cancelled',
])

export type WfRunProgress = {
  /** The run's overall status (queued | running | done | completed | failed | cancelled). */
  status: string
  /** Node id of the step currently running, else the most recent step. */
  activeNodeId: string | null
  /** Human label of that node — e.g. "Draft the recipes". Null when unknown. */
  activeLabel: string | null
  /** That node's kind (agent | tool | iteration | branch | …). */
  activeKind: string | null
  /** Distinct top-level nodes that have reached a terminal state. */
  completed: number
  /** Executable top-level nodes in the graph — the progress denominator. */
  total: number
  /** 0–100. Pinned to 100 once the run itself is terminal. */
  percent: number
}

// The minimal step shape progress needs. Both the durable trace row and the
// wire DTO satisfy it structurally, so callers pass their rows as-is.
export type ProgressStep = {
  nodeId: string
  nodeKind?: string
  /** Iteration container this step ran inside, or null/absent for a top-level step. */
  parentNodeId?: string | null
  status: string
  sequence: number
}

function latestBySequence<T extends { sequence: number }>(
  steps: T[],
): T | null {
  if (steps.length === 0) return null
  return steps.reduce((a, b) => (b.sequence > a.sequence ? b : a))
}

/**
 * Summarise a run's live position from its graph + recorded steps.
 *
 * Only top-level steps drive the bar; iteration sub-steps (which carry a
 * `parentNodeId`) roll up under their container node. Because branch/switch
 * nodes skip whole arms, `completed` may never reach `total` mid-run — so once
 * the run status is terminal we pin `percent` to 100 rather than leaving a bar
 * stuck at, say, 6/9.
 */
export function deriveRunProgress(input: {
  status: string
  graph: WorkflowGraph | null
  steps: ProgressStep[]
}): WfRunProgress {
  const { status, graph, steps } = input

  const topLevel = steps.filter((s) => !s.parentNodeId)

  const total = graph
    ? graph.nodes.filter((n) => !NON_STEP_KINDS.has(n.kind)).length
    : 0

  const completed = new Set(
    topLevel
      .filter((s) => TERMINAL_STEP_STATUSES.has(s.status))
      .map((s) => s.nodeId),
  ).size

  // Prefer a running step as "active"; otherwise the furthest-along step so the
  // label reflects the last thing that happened rather than going blank between
  // node transitions.
  const running = topLevel.filter((s) => s.status === 'running')
  const active = latestBySequence(running) ?? latestBySequence(topLevel) ?? null

  const activeNode =
    active && graph
      ? (graph.nodes.find((n) => n.id === active.nodeId) ?? null)
      : null

  const isTerminal = TERMINAL_RUN_STATUSES.has(status)
  const percent = isTerminal
    ? 100
    : total > 0
      ? Math.min(99, Math.round((completed / total) * 100))
      : 0

  return {
    status,
    activeNodeId: active?.nodeId ?? null,
    activeLabel: activeNode?.label ?? null,
    activeKind: activeNode?.kind ?? active?.nodeKind ?? null,
    completed,
    total,
    percent,
  }
}
