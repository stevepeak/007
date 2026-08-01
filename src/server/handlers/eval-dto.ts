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
    snapshot?: unknown
    snapshotHash?: string | null
    modelId?: string | null
    promptLabel?: string | null
    promptBody?: string | null
    attempt?: number | null
    createdAt: Date
  },
  runStats?: RunStats | null,
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
    snapshot: (r.snapshot as EvalRowSnapshot | null) ?? null,
    snapshotHash: r.snapshotHash ?? null,
    modelId: r.modelId ?? null,
    promptLabel: r.promptLabel ?? null,
    promptBody: r.promptBody ?? null,
    attempt: r.attempt ?? null,
    createdAt: r.createdAt.getTime(),
  }
}
