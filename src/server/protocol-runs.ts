import type { WorkflowGraph } from '../engine/graph'

export type WfRunSummary = {
  id: string
  status: string
  triggerKind: string
  /** The workflow this run executed (resolved through its version). */
  workflowId: string
  workflowName: string
  versionNumber: number
  /** Opaque host references carried on the run (nullable). */
  subjectId: string | null
  correlationId: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  error: string | null
  /** The shared Markdown note written on this run; null when nobody has. */
  note: string | null
  /** Total tokens across the run's agent steps; null when it ran no agents. */
  totalTokens: number | null
  /** Aggregate USD cost across the run's agent steps; null when no agent ran or
   *  none of their models are priced. Derived from token usage × model price. */
  costUsd: number | null
  /** Stable 32-hex trace id for the run's Sentry spans (null for old runs). */
  sentryTraceId: string | null
  /** Deep-link into the Sentry trace, built by the host from `sentryTraceId`.
   * Null when the host wires no Sentry org (see CreateWfSdkHandlersOptions). */
  sentryTraceUrl: string | null
  /**
   * The run that spawned this one, or null for a top-level run.
   *
   * `nodeId` is the workflow-call or iteration node in the PARENT's graph;
   * `itemIndex` is the 0-based position for a durable iteration item, and null
   * for a workflow-call callee (one callee per node, so it has no position).
   * This is the only link that survives the parent finishing — see
   * `wf_run.parent_run_id`.
   *
   * `workflowName` names the parent's workflow, so a child reached by direct
   * link can say where "up" goes. Only the single-run inspector resolves it —
   * the list reads pay for no extra join and leave it null.
   *
   * `itemTitle` is what to CALL this item — the container's `itemTitle`
   * template resolved against the item's own value at spawn time. Null when
   * the author set no template or it resolved to nothing, in which case every
   * surface falls back to "Item N" via `iterationItemLabel`.
   */
  parent: {
    runId: string
    nodeId: string
    itemIndex: number | null
    workflowName: string | null
    itemTitle: string | null
  } | null
  /**
   * What this run cost INCLUDING every run it spawned, or null when it spawned
   * none — in which case {@link costUsd} above already is the whole story.
   *
   * Kept beside the run's own figures rather than replacing them because both
   * are true and they answer different questions: a durable fan-out's parent
   * legitimately did almost nothing itself, and that is worth being able to
   * see next to what the whole upload cost.
   */
  tree: WfRunTreeTotals | null
}

/**
 * A run's totals summed over its whole subtree.
 *
 * The two time figures are deliberately not one number. A run's ELAPSED time is
 * its own wall clock and already covers its children, since a parent parks
 * until they report. {@link computeMs} is ADDITIVE across the tree and so
 * exceeds elapsed time whenever children ran concurrently — that gap is the
 * entire return on durable fan-out, and summing the two into one figure would
 * read as elapsed and overstate it by the concurrency factor.
 */
export type WfRunTreeTotals = {
  totalTokens: number | null
  costUsd: number | null
  /** Every model used anywhere in the tree, deduped. */
  models: string[]
  /** Summed agent-call time across the tree; null when none closed a window. */
  agentMs: number | null
  /** Summed RUN time across the tree — additive, not elapsed. */
  computeMs: number | null
  /** Runs folded in, including this one. Always ≥ 2 when this object exists. */
  runCount: number
  /** Runs in the tree not yet in a terminal state — non-zero means these
   *  totals are a floor, not a final figure. */
  pending: number
}

/**
 * How a run's children are doing, without loading them — attached to every row
 * of the runs list so a fan-out is legible while still collapsed.
 *
 * `failed` is carried separately rather than derived on expand because it is
 * the number that has to survive into a COLLAPSED row: under `stopOnError:
 * false` a failed item leaves a placeholder and the parent still completes, so
 * a run that reads green at the top level can be hiding a failure — and nobody
 * expands a row that looks fine.
 */
export type WfRunChildCounts = {
  total: number
  /** Children in a terminal state (completed / failed / cancelled). */
  settled: number
  failed: number
}

/**
 * A row of the runs list: a run that HEADS a tree, plus how many children it
 * spawned. Children are never rows of their own here — they are fetched with
 * {@link WfDataClient.listChildRuns} when the row is expanded.
 *
 * `costUsd` on this row is the run's OWN cost; `tree` (on {@link WfRunSummary})
 * carries the total across everything it spawned. Both are sent, because a
 * parent that itself cost $0.02 while its items spent $4 is worth being able
 * to see either way round.
 */
export type WfRunListRow = WfRunSummary & {
  /** Null when this run spawned nothing — distinct from a fan-out of zero. */
  children: WfRunChildCounts | null
}

// Filters + pagination for the runs explorer. All optional; `search` matches
// workflow name / trigger kind / subject / correlation / note. `since`/`until`
// are epoch millis over the run's createdAt.
export type WfRunListInput = {
  workflowVersionId?: string
  workflowId?: string
  triggerKind?: string
  status?: string
  search?: string
  since?: number
  until?: number
  limit?: number
  offset?: number
}

export type WfRunListResult = {
  runs: WfRunListRow[]
  /** Total rows matching the filter (ignoring limit/offset) — drives paging. */
  total: number
  limit: number
  offset: number
}

// What a "delete all runs" purge removed, so the UI can report it. Every count
// is rows actually deleted, except `feedbackUnlinked` — those rows are KEPT,
// with their dangling `runId` cleared. See `deleteAllRuns` in storage.
export type WfRunPurgeResult = {
  runs: number
  steps: number
  logs: number
  evalResults: number
  evalRuns: number
  feedbackUnlinked: number
}

// How the run viewer's Retry re-dispatches a finished run.
// `restart` = fresh, from the start, on the latest version; `resume` = reuse the
// original version and pick up at the failed step.
export type RetryRunMode = 'restart' | 'resume'

/**
 * The settle-check payload — the three fields a poll loop acts on, read off one
 * indexed run row. The cheap sibling of {@link WfRunDetail}: anything that only
 * needs to notice a run finished asks for this. See `WfDataClient.getRunStatus`.
 */
export type WfRunStatusDTO = {
  status: string
  output: unknown
  error: string | null
}

export type WfRunStepDTO = {
  /**
   * Opaque, strictly-increasing key in the order the engine recorded steps.
   * Stable for the life of a row: a step keeps its cursor as it moves from
   * `running` to terminal.
   *
   * This — not `sequence` — is the identity for merging an incremental steps
   * read (see `stepsPartial`). `sequence` is a per-walk counter that restarts
   * at 0 inside an iteration's per-item subgraph and inside a sub-agent's child
   * run, so it is neither unique nor monotonic within a run.
   */
  cursor: number
  nodeId: string
  nodeKind: string
  /**
   * The iteration container this step ran inside, or null for a top-level step.
   * Sub-steps of an iteration repeat their `nodeId` once per item — pair with
   * {@link WfRunStepDTO.itemIndex} to address a specific item's node.
   */
  parentNodeId: string | null
  /** 0-based item index within an iteration; null for a top-level step. */
  itemIndex: number | null
  sequence: number
  status: string
  input: unknown
  output: unknown
  branchResult: unknown
  meta: unknown
  error: string | null
  /** Node execution window (epoch millis) — drives the Inspect "speed" card.
   *  Null when the recorder captured no timing. */
  startedAt: number | null
  finishedAt: number | null
  /** Derived USD cost of this step's token usage; null for non-agent steps or
   *  models the catalog hasn't priced. */
  costUsd: number | null
}

// One structured entry in the run's progress feed (the run viewer's Logs panel).
export type WfRunLogDTO = {
  nodeId: string | null
  nodeKind: string | null
  sequence: number | null
  level: string
  message: string
  meta: unknown
  /** Engine emit time (epoch millis) — the feed's sort key. */
  ts: number
}

export type WfRunDetail = {
  run: WfRunSummary & { output: unknown }
  steps: WfRunStepDTO[]
  /**
   * Set when the caller passed a `settledStepCursor`, meaning `steps` holds ONLY
   * the steps above that watermark: the caller must merge them into the set it
   * already holds (keyed on {@link WfRunStepDTO.cursor}) rather than replace it.
   * Absent on a full load.
   */
  stepsPartial?: true
  /** The structured progress feed, in emit order. */
  logs: WfRunLogDTO[]
  /**
   * Set when the run's feed is longer than the server's read cap and `logs`
   * holds only its newest entries. A presence flag like `versionOmitted`: the
   * UI says so rather than presenting a clipped feed as the whole story.
   */
  logsTruncated?: true
  graph: WorkflowGraph | null
  versionNumber: number | null
  /**
   * The version this run is pinned to. Immutable for the life of the run, and
   * the cache key a poller passes back as `knownVersionId` to suppress the
   * version block on subsequent fetches.
   */
  workflowVersionId: string
  /**
   * Set when the caller's `knownVersionId` matched, meaning the version block
   * was NOT read: `graph`, `versionNumber`, and `run`'s `workflowId` /
   * `workflowName` / `versionNumber` are placeholders, and the caller must
   * splice in the values it already holds. Absent on a full load.
   */
  versionOmitted?: true
}
