import type { EvalCheck, WfEvalResultDTO } from '../../../server/protocol'

// Pure data model + logic for the eval run report — no React. Everything the
// results table sorts, filters, groups, and crowns is derived here from each
// result's frozen `snapshot`, so the UI layers stay thin and this stays
// unit-testable in isolation.

// A flat, pre-resolved view of a result — one table row.
export type ResultRow = {
  result: WfEvalResultDTO
  status: string
  sampleName: string
  setId: string | null
  goalName: string
  checks: EvalCheck[]
  modelLabel: string | null
  promptLabel: string | null
  score: number | null
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
  | 'duration'
  | 'cost'
  | 'tokens'

export type SortState = { key: SortKey; dir: 'asc' | 'desc' }

export type GroupBy = 'none' | 'sample' | 'status' | 'model' | 'prompt'

export type GroupEntry = { key: string; label: string; rows: ResultRow[] }

// Failures first by default so problems surface at the top.
export const STATUS_RANK: Record<string, number> = { fail: 0, error: 1, pass: 2 }

export function mean(vals: number[]): number | null {
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
}

// Stable identity for a matrix cell — one {model × prompt} combination. Shared
// by the matrix summary (which cell won a column) and the results table (which
// rows belong to a cell), so hovering a summary card can light up its rows.
export function cellKey(
  modelId: string | null,
  promptLabel: string | null,
): string {
  return `${modelId ?? ''} ${promptLabel ?? ''}`
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
    const modelLabel = r.modelId
      ? (labelOf(r.modelId) ?? r.modelId)
      : (r.runStats?.models[0] ?? null)
    return {
      result: r,
      status: r.status,
      sampleName: snap?.row.name ?? r.rowId,
      setId: snap?.target.setId ?? null,
      goalName: snap?.target.setName ?? 'Goal',
      checks: snap?.row.checks.checks ?? [],
      modelLabel,
      promptLabel: r.promptLabel,
      score: r.score,
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
  const entries = [...map.entries()].map(([key, rs]) => ({
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
