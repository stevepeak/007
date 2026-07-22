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
}

// Filters + pagination for the runs explorer. All optional; `search` matches
// workflow name / trigger kind / subject / correlation. `since`/`until` are
// epoch millis over the run's createdAt.
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
  runs: WfRunSummary[]
  /** Total rows matching the filter (ignoring limit/offset) — drives paging. */
  total: number
  limit: number
  offset: number
}

// How the run viewer's Retry re-dispatches a finished run.
// `restart` = fresh, from the start, on the latest version; `resume` = reuse the
// original version and pick up at the failed step.
export type RetryRunMode = 'restart' | 'resume'

export type WfRunStepDTO = {
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
  /** The structured progress feed, in emit order. */
  logs: WfRunLogDTO[]
  graph: WorkflowGraph | null
  versionNumber: number | null
}
