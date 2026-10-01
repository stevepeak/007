import { tokenCostUsd, type ModelPriceMap } from '../../engine/cost'
import type { RunStats } from '../../storage/data'
import type {
  EvalRowSnapshot,
  WfEvalResultDTO,
  WfEvalRunSummary,
  WfEvalSetSummary,
  WfEvalTargetKind,
} from '../protocol'

import { toEpoch } from './shared'

// Row → protocol-DTO mappers for the evals handlers: pure shaping that turns a
// stored set / run / result row into the wire type the client reads. Kept apart
// from the handler orchestration so the shapes live in one place.

export function evalSetSummary(
  s: {
    id: string
    name: string
    description: string | null
    targetKind: WfEvalTargetKind
    targetId: string
    targetVersion: number | null
    triggerKind: string
    archived: boolean
    createdAt: Date
    updatedAt: Date | null
  },
  rowCount: number,
): WfEvalSetSummary {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    targetKind: s.targetKind,
    targetId: s.targetId,
    targetVersion: s.targetVersion,
    triggerKind: s.triggerKind,
    archived: s.archived,
    rowCount,
    createdAt: s.createdAt.getTime(),
    updatedAt: toEpoch(s.updatedAt),
  }
}

export function evalRunSummary(r: {
  id: string
  status: string
  setIds: unknown
  total: number
  passed: number
  failed: number
  score: number | null
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
}): WfEvalRunSummary {
  return {
    id: r.id,
    status: r.status,
    setIds: Array.isArray(r.setIds) ? (r.setIds as string[]) : [],
    total: r.total,
    passed: r.passed,
    failed: r.failed,
    score: r.score,
    createdAt: r.createdAt.getTime(),
    startedAt: toEpoch(r.startedAt),
    finishedAt: toEpoch(r.finishedAt),
  }
}

export function evalResultDTO(
  r: {
    id: string
    evalRunId: string
    rowId: string
    wfRunId: string | null
    status: WfEvalResultDTO['status']
    score: number | null
    checkResults: unknown
    error?: string | null
    snapshot?: unknown
    snapshotHash?: string | null
    modelId?: string | null
    promptLabel?: string | null
    promptBody?: string | null
    attempt?: number | null
    answeredModelId?: string | null
    createdAt: Date
  },
  runStats?: RunStats | null,
  previousSnapshotHash?: string | null,
): WfEvalResultDTO {
  return {
    id: r.id,
    evalRunId: r.evalRunId,
    rowId: r.rowId,
    wfRunId: r.wfRunId,
    runStats: runStats ?? null,
    status: r.status,
    score: r.score,
    checkResults: Array.isArray(r.checkResults)
      ? (r.checkResults as WfEvalResultDTO['checkResults'])
      : [],
    error: r.error ?? null,
    snapshot: (r.snapshot as EvalRowSnapshot | null) ?? null,
    snapshotHash: r.snapshotHash ?? null,
    previousSnapshotHash: previousSnapshotHash ?? null,
    modelId: r.modelId ?? null,
    promptLabel: r.promptLabel ?? null,
    promptBody: r.promptBody ?? null,
    attempt: r.attempt ?? null,
    answeredModelId: r.answeredModelId ?? null,
    createdAt: r.createdAt.getTime(),
  }
}

/**
 * `RunStats` for a cell that produced NO `wf_run` — today, a decision cell.
 *
 * A run-backed cell derives its tokens and dollars from the run's agent steps
 * (`loadRunStats`), which remains the single source of truth wherever a run
 * exists. A decision cell calls the provider directly and leaves no run, no
 * steps and nothing for that fold to read, so its usage is recorded on the
 * result row itself and assembled back into the SAME shape here.
 *
 * Same shape on purpose. The cost panel, the MCP report and the UI's stats line
 * all read `runStats`; giving decision cells a parallel field would mean three
 * renderers growing a second branch each, and a decision sweep reporting
 * `measuredCells: 0` until all three were found.
 *
 * The dollars are derived, not stored — from `wf_model`'s price columns, through
 * the same {@link tokenCostUsd} the run fold uses. So a decision cell and an
 * agent cell cannot disagree about what a token costs, and re-pricing the
 * catalog re-prices both.
 *
 * `durationMs` and `agentVersion` stay null: there was no run to time, and a
 * decision agent's version rides on the result's frozen `snapshot` instead.
 * Returns null when the cell recorded no usage at all, so a cell from before
 * these columns existed reads as "unmeasured" rather than as free.
 */
export function runlessCellStats(
  r: {
    inputTokens?: number | null
    outputTokens?: number | null
    modelId?: string | null
    answeredModelId?: string | null
  },
  priceMap: ModelPriceMap,
): RunStats | null {
  const inputTokens = r.inputTokens ?? null
  const outputTokens = r.outputTokens ?? null
  if (inputTokens == null && outputTokens == null) return null
  const input = inputTokens ?? 0
  const output = outputTokens ?? 0
  // Which model to price against, and why it is not simply `modelId`:
  //
  // `modelId` is MATRIX IDENTITY, not "the model that ran" — a plain run leaves
  // it null on purpose, and `isMatrixRun` keys on exactly that, so filling it in
  // for a baseline cell would make every single-model decision sweep render as a
  // matrix. The echo is therefore the fallback, and it is the better answer
  // anyway: `answeredModelId` is by definition what answered.
  //
  // Prefer the asked id when there IS one (a matrix cell), since that is the id
  // the catalog holds a row for. When the echo resolves to something the catalog
  // has never seen — a provider that turns `jev-latest` into a dated build —
  // there is no price to find and `costUsd` stays null, which is the honest
  // answer rather than a zero.
  const priced = r.modelId ?? r.answeredModelId ?? null
  return {
    totalTokens: input + output,
    costUsd:
      priced == null ? null : tokenCostUsd(input, output, priceMap.get(priced)),
    models: priced == null ? [] : [priced],
    durationMs: null,
    agentVersion: null,
  }
}
