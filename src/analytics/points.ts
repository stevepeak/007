import type { WfNodeKind } from '../engine/graph'
import type { WfRunStepStatus } from '../engine/run-recorder'
import { asAgentMeta, tokenCostUsd, type ModelPriceMap } from '../storage/cost'

// ═══════════════════════════════════════════════════════════════════════════
// AE COLUMN LAYOUT — schema v1. APPEND-ONLY, FOREVER.
//
// Analytics Engine columns are POSITIONAL and cannot be renamed or reordered
// after the first write. Renumbering an ordinal silently reinterprets three
// months of history. The ONLY legal changes are:
//   • fill a slot marked (reserved)
//   • bump TELEMETRY_SCHEMA_VERSION and add NEW ordinals
// Never repurpose a used ordinal. Readers filter on blob2 to stay honest.
//
// ── COMMON (identical on every point type) ─────────────────────────────────
// index1   workflowId                     — sampling key; AE samples WITHIN an
//                                           index, so a busy workflow thins out
//                                           while a quiet one stays exact.
// blob1    pointType         'run' | 'step'
// blob2    schemaVersion     '1'
// blob3    workflowId
// blob4    workflowVersionId
// blob5    runId             (wf_run.id)
// blob6    triggerKind
// blob7    traceId           ('' for runs started before tracing)
// double1  isEval            0 | 1
// double2  simulate          0 | 1
//
// ── pointType = 'step' (one per TERMINAL run-step record) ──────────────────
// blob8    nodeId
// blob9    nodeKind
// blob10   status            'completed' | 'failed' | 'skipped'
// blob11   modelId           agent steps only, '' otherwise
// blob12   agentId           agent steps only, ''
// blob13   toolId            tool steps only, ''
// blob14   parentNodeId      iteration sub-steps, '' at top level
// blob15   errorText         truncated to 120 chars, '' on success
// blob16-20  (reserved)
// double3  sequence
// double4  itemIndex         -1 = top level (matches wf_run_step's sentinel)
// double5  latencyMs         finishedAt − startedAt, 0 when unmeasured
// double6  inputTokens
// double7  outputTokens
// double8  costUsdMicros     USD × 1e6, priced at EXECUTION time
// double9  priced            1 when the model had a catalog price, else 0
// double10 turns             agent meta.steps.length
// double11 toolCalls         summed across turns
// double12 stoppedOnTokenBudget   0 | 1
// double13 stoppedOnContextLimit  0 | 1
// double14-20  (reserved)
//
// ── pointType = 'run' (one per run terminal) ───────────────────────────────
// blob8    status            'completed' | 'failed'
// blob9    outputNodeId      '' when the run failed or reached no Output
// blob10   errorText         truncated to 200 chars, '' on success
// blob11   engine            'durable' | 'inline'
// blob12-20  (reserved)
// double3  runLatencyMs
// double4  nodeCount         top-level nodes the scheduler actually fired
// double5  iterationItems    items executed across every iteration node
// double6  workflowSteps     ← the Cloudflare Workflows billing unit
// double7  failedNodeCount
// double8  droppedPoints     suppressed by the per-invocation cap
// double9  runStartedAtSec   epoch SECONDS — the bucketing key for run volume
// double10-20  (reserved)
// ═══════════════════════════════════════════════════════════════════════════
//
// A step point's identity — `runId + nodeId + itemIndex` (blob5, blob8,
// double4) — names exactly one `wf_run_step` row, so no blob is spent carrying
// a dedup key. It is a dedup key for READERS, not a uniqueness guarantee: AE
// records ATTEMPTS while D1 records FINAL STATE, so a retried step legitimately
// appears twice (and those tokens were genuinely spent twice).

/** Bumped only when ordinals are ADDED. Readers filter on it. */
export const TELEMETRY_SCHEMA_VERSION = '1'

/** Error text budgets. Step points are far more numerous, so they get less. */
const STEP_ERROR_CHARS = 120
const RUN_ERROR_CHARS = 200

/** A single encoded data point, in `writeDataPoint`'s exact shape. */
export type TelemetryPoint = {
  indexes: [string]
  blobs: string[]
  doubles: number[]
}

/**
 * The run-scoped dimensions every point carries. Assembled once when a run's
 * telemetry is set up and reused for every step — nothing here changes mid-run.
 */
export type RunDims = {
  /**
   * Ranks above `workflowVersionId` as the sampling key: bounded cardinality,
   * and the dimension the run-volume chart groups by. Falls back to the version
   * id when unresolved, so `index1` is never empty.
   */
  workflowId: string
  workflowVersionId: string
  runId: string
  triggerKind: string
  traceId?: string
  isEval?: boolean
  simulate?: boolean
}

export type StepPointInput = {
  nodeId: string
  nodeKind: WfNodeKind
  status: WfRunStepStatus
  sequence: number
  /** 0-based within an iteration; absent/null → the `-1` top-level sentinel. */
  itemIndex?: number | null
  parentNodeId?: string | null
  startedAt?: Date
  finishedAt?: Date
  /** The step's recorded `meta` — narrowed here, never trusted. */
  meta?: unknown
  error?: string
}

export type RunPointInput = {
  status: 'completed' | 'failed'
  /** Which backend ran it; inline runs bill no Workflows steps. */
  engine: 'durable' | 'inline'
  outputNodeId?: string | null
  error?: string
  /** Epoch ms — the run's own start, not the point's emission time. */
  startedAtMs: number
  finishedAtMs: number
  nodeCount: number
  iterationItems: number
  workflowSteps: number
  failedNodeCount: number
  droppedPoints: number
}

function trunc(text: string | undefined | null, max: number): string {
  if (!text) return ''
  return text.length <= max ? text : text.slice(0, max)
}

/** Milliseconds between two stamps, floored at 0 and 0 when either is absent. */
function latencyMs(startedAt?: Date, finishedAt?: Date): number {
  if (!startedAt || !finishedAt) return 0
  return Math.max(0, finishedAt.getTime() - startedAt.getTime())
}

/** The `toolId` a tool step records in its `meta`, or '' for every other kind. */
function toolIdOf(meta: unknown): string {
  if (!meta || typeof meta !== 'object') return ''
  const id = (meta as { toolId?: unknown }).toolId
  return typeof id === 'string' ? id : ''
}

/**
 * The LLM-shaped numbers a step contributes, all zero for a non-agent step.
 * `priced` distinguishes "cost $0" from "this model has no catalog price" —
 * without it, unpriced tokens would silently read as free.
 */
function agentDoubles(
  meta: unknown,
  prices: ModelPriceMap | undefined,
): {
  modelId: string
  agentId: string
  inputTokens: number
  outputTokens: number
  costUsdMicros: number
  priced: number
  turns: number
  toolCalls: number
  stoppedOnTokenBudget: number
  stoppedOnContextLimit: number
} {
  const empty = {
    modelId: '',
    agentId: '',
    inputTokens: 0,
    outputTokens: 0,
    costUsdMicros: 0,
    priced: 0,
    turns: 0,
    toolCalls: 0,
    stoppedOnTokenBudget: 0,
    stoppedOnContextLimit: 0,
  }
  const agent = asAgentMeta(meta)
  if (!agent) return empty

  const inputTokens = agent.totalUsage?.inputTokens ?? 0
  const outputTokens = agent.totalUsage?.outputTokens ?? 0
  const cost = prices
    ? tokenCostUsd(inputTokens, outputTokens, prices.get(agent.model))
    : null
  return {
    modelId: agent.model ?? '',
    agentId: agent.agentId ?? '',
    inputTokens,
    outputTokens,
    // Integer micros, so SQL sums stay exact and the API console stays readable.
    costUsdMicros: cost == null ? 0 : Math.round(cost * 1_000_000),
    priced: cost == null ? 0 : 1,
    turns: agent.steps?.length ?? 0,
    toolCalls: (agent.steps ?? []).reduce(
      (n, s) => n + (s.toolCalls?.length ?? 0),
      0,
    ),
    stoppedOnTokenBudget: agent.stoppedOnTokenBudget ? 1 : 0,
    stoppedOnContextLimit: agent.stoppedOnContextLimit ? 1 : 0,
  }
}

/** The common prefix — blob1..blob7 and double1..double2 — shared by both types. */
function common(
  dims: RunDims,
  pointType: 'run' | 'step',
): { indexes: [string]; blobs: string[]; doubles: number[] } {
  return {
    indexes: [dims.workflowId || dims.workflowVersionId],
    blobs: [
      pointType, // blob1
      TELEMETRY_SCHEMA_VERSION, // blob2
      dims.workflowId, // blob3
      dims.workflowVersionId, // blob4
      dims.runId, // blob5
      dims.triggerKind, // blob6
      dims.traceId ?? '', // blob7
    ],
    doubles: [
      dims.isEval ? 1 : 0, // double1
      dims.simulate ? 1 : 0, // double2
    ],
  }
}

/**
 * Encode one terminal run-step. `prices` is the run's frozen catalog snapshot;
 * omit it and the cost ordinals ship as 0/0 (readers see `priced = 0`).
 */
export function encodeStepPoint(
  dims: RunDims,
  input: StepPointInput,
  prices?: ModelPriceMap,
): TelemetryPoint {
  const point = common(dims, 'step')
  const a = agentDoubles(input.meta, prices)
  point.blobs.push(
    input.nodeId, // blob8
    input.nodeKind, // blob9
    input.status, // blob10
    a.modelId, // blob11
    a.agentId, // blob12
    toolIdOf(input.meta), // blob13
    input.parentNodeId ?? '', // blob14
    trunc(input.error, STEP_ERROR_CHARS), // blob15
  )
  point.doubles.push(
    input.sequence, // double3
    input.itemIndex ?? -1, // double4
    latencyMs(input.startedAt, input.finishedAt), // double5
    a.inputTokens, // double6
    a.outputTokens, // double7
    a.costUsdMicros, // double8
    a.priced, // double9
    a.turns, // double10
    a.toolCalls, // double11
    a.stoppedOnTokenBudget, // double12
    a.stoppedOnContextLimit, // double13
  )
  return point
}

/**
 * Encode a run terminal. Token and cost totals are deliberately absent — they
 * are SUMmed from the step points (grouped by blob5), because a second
 * accumulator would diverge and would miss iteration + sub-agent steps.
 */
export function encodeRunPoint(
  dims: RunDims,
  input: RunPointInput,
): TelemetryPoint {
  const point = common(dims, 'run')
  point.blobs.push(
    input.status, // blob8
    input.outputNodeId ?? '', // blob9
    trunc(input.error, RUN_ERROR_CHARS), // blob10
    input.engine, // blob11
  )
  point.doubles.push(
    Math.max(0, input.finishedAtMs - input.startedAtMs), // double3
    input.nodeCount, // double4
    input.iterationItems, // double5
    input.workflowSteps, // double6
    input.failedNodeCount, // double7
    input.droppedPoints, // double8
    // Seconds, and the run's START: the point is emitted at finish, so
    // bucketing on AE's ingest timestamp would shift a long run into the next
    // bucket and break reconciliation with the D1 chart's `wf_run.created_at`.
    Math.floor(input.startedAtMs / 1000), // double9
  )
  return point
}
