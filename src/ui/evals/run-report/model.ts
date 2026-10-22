import { DEFAULT_DECISION_THRESHOLD } from '../../../engine/decision'
import {
  isJudgeCheck,
  upgradeLegacyCheck,
  type EvalCheck,
  type WfEvalResultDTO,
} from '../../../server/protocol'

// Pure data model + logic for the eval run report — no React. Everything the
// results table sorts, filters, groups, and crowns is derived here from each
// result's frozen `snapshot`, so the UI layers stay thin and this stays
// unit-testable in isolation.

// A flat, pre-resolved view of a result — one table row.
export type ResultRow = {
  result: WfEvalResultDTO
  status: string
  /** Why an `error` row has no verdict; null for pass/fail. */
  error: string | null
  sampleName: string
  setId: string | null
  goalName: string
  checks: EvalCheck[]
  modelLabel: string | null
  promptLabel: string | null
  score: number | null
  /**
   * How close the row's nearest judge call came to its line: the smallest
   * |p − threshold| over its judge checks. Null when no judge reported a
   * probability.
   */
  margin: number | null
  durationMs: number | null
  costUsd: number | null
  tokens: number | null
}

export type SortKey =
  | 'status'
  | 'sample'
  | 'goal'
  | 'model'
  | 'prompt'
  | 'score'
  | 'margin'
  | 'duration'
  | 'cost'
  | 'tokens'

export type SortState = { key: SortKey; dir: 'asc' | 'desc' }

export type GroupBy = 'none' | 'sample' | 'status' | 'model' | 'prompt'

export type GroupEntry = { key: string; label: string; rows: ResultRow[] }

// Failures first by default so problems surface at the top.
export const STATUS_RANK: Record<string, number> = { fail: 0, error: 1, pass: 2 }

// `mean` and `cellKey` live in `eval/report.ts` with the rest of the report's
// arithmetic, so the console and `get_eval_run` compute the same numbers. Kept
// re-exported here because this module is where the UI already imports them from.
export { cellKey, mean } from '../../../eval/report'

/** A row whose nearest judge call landed within this of its line. */
export const BORDERLINE_BAND = 0.1

export function isBorderline(row: ResultRow): boolean {
  return row.margin != null && row.margin <= BORDERLINE_BAND
}

/** See {@link ResultRow.margin}. */
export function judgeMargin(
  checks: EvalCheck[],
  results: WfEvalResultDTO['checkResults'],
): number | null {
  let margin: number | null = null
  for (const [i, cr] of results.entries()) {
    const check = checks[i]
    if (cr.probability == null || !check || !isJudgeCheck(check)) continue
    const gap = Math.abs(
      cr.probability - (check.threshold ?? DEFAULT_DECISION_THRESHOLD),
    )
    margin = margin == null ? gap : Math.min(margin, gap)
  }
  return margin
}

// Build the flat rows the table renders, from results + a model-label resolver
// (composite modelId → display label). Falls back to the run's own recorded
// model id when the cell wasn't a matrix cell.
export function buildResultRows(
  results: WfEvalResultDTO[],
  labelOf: (modelId: string) => string | undefined,
): ResultRow[] {
  return results.map((r) => {
    const snap = r.snapshot
    // A frozen snapshot can still hold a legacy `llm_judge`.
    const checks = (snap?.row.checks.checks ?? []).map(
      (c) => upgradeLegacyCheck(c) as EvalCheck,
    )
    const modelLabel = r.modelId
      ? (labelOf(r.modelId) ?? r.modelId)
      : (r.runStats?.models[0] ?? null)
    return {
      result: r,
      status: r.status,
      error: r.error,
      sampleName: snap?.row.name ?? r.rowId,
      setId: snap?.target.setId ?? null,
      goalName: snap?.target.setName ?? 'Goal',
      checks,
      modelLabel,
      promptLabel: r.promptLabel,
      score: r.score,
      margin: judgeMargin(checks, r.checkResults),
      durationMs: r.runStats?.durationMs ?? null,
      costUsd: r.runStats?.costUsd ?? null,
      tokens: r.runStats?.totalTokens ?? null,
    }
  })
}

function sortValue(r: ResultRow, key: SortKey): number | string | null {
  switch (key) {
    case 'status':
      return STATUS_RANK[r.status] ?? 3
    case 'sample':
      return r.sampleName.toLowerCase()
    case 'goal':
      return r.goalName.toLowerCase()
    case 'model':
      return r.modelLabel?.toLowerCase() ?? null
    case 'prompt':
      return r.promptLabel?.toLowerCase() ?? null
    case 'score':
      return r.score
    case 'margin':
      return r.margin
    case 'duration':
      return r.durationMs
    case 'cost':
      return r.costUsd
    case 'tokens':
      return r.tokens
  }
}

// Sort a copy of `rows` by the active column; nulls always sort last.
export function sortRows(rows: ResultRow[], sort: SortState): ResultRow[] {
  const dir = sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const va = sortValue(a, sort.key)
    const vb = sortValue(b, sort.key)
    if (va == null && vb == null) return 0
    if (va == null) return 1
    if (vb == null) return -1
    if (va < vb) return -1 * dir
    if (va > vb) return 1 * dir
    return 0
  })
}

function groupKeyOf(r: ResultRow, by: GroupBy): string {
  switch (by) {
    case 'sample':
      return r.sampleName
    case 'status':
      return r.status
    case 'model':
      return r.modelLabel ?? '—'
    case 'prompt':
      return r.promptLabel ?? '—'
    case 'none':
      return ''
  }
}

// Bucket rows by group key, preserving the order rows already arrive in (i.e.
// the active sort), then order the group headers: pass/fail by severity
// (fail → error → pass), everything else alphabetically.
export function groupRows(rows: ResultRow[], by: GroupBy): GroupEntry[] {
  const map = new Map<string, ResultRow[]>()
  for (const r of rows) {
    const key = groupKeyOf(r, by)
    const bucket = map.get(key)
    if (bucket) bucket.push(r)
    else map.set(key, [r])
  }
  const entries = [...map].map(([key, rs]) => ({
    key,
    label: key,
    rows: rs,
  }))
  return entries.sort((a, b) => {
    if (by === 'status') {
      return (STATUS_RANK[a.key] ?? 3) - (STATUS_RANK[b.key] ?? 3)
    }
    return a.key.localeCompare(b.key)
  })
}

// Best test overall: a pass beats a non-pass, then higher score, then cheaper,
// then faster. Missing figures rank worst so a fully-measured winner is favored.
export function pickBest(rows: ResultRow[]): string | null {
  let best: ResultRow | null = null
  for (const r of rows) {
    if (best == null || betterThan(r, best)) best = r
  }
  return best?.result.id ?? null
}

function betterThan(a: ResultRow, b: ResultRow): boolean {
  const ap = a.status === 'pass' ? 1 : 0
  const bp = b.status === 'pass' ? 1 : 0
  if (ap !== bp) return ap > bp
  const as = a.score ?? -1
  const bs = b.score ?? -1
  if (as !== bs) return as > bs
  const ac = a.costUsd ?? Infinity
  const bc = b.costUsd ?? Infinity
  if (ac !== bc) return ac < bc
  return (a.durationMs ?? Infinity) < (b.durationMs ?? Infinity)
}

// Id of the row with the smallest non-null picked value (fastest / cheapest).
export function minBy(
  rows: ResultRow[],
  pick: (r: ResultRow) => number | null,
): string | null {
  let best: ResultRow | null = null
  let bestVal = Infinity
  for (const r of rows) {
    const v = pick(r)
    if (v == null) continue
    if (v < bestVal) {
      bestVal = v
      best = r
    }
  }
  return best?.result.id ?? null
}
