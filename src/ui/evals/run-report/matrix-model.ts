import type { WfEvalResultDTO } from '../../../server/protocol'

import { cellKey, mean } from './model'

// The matrix roll-up, as arithmetic: collapse every test back into one row per
// {model × prompt} cell and work out which cell wins on accuracy, cost, and
// speed. Kept out of the component so it can be tested against a fixture rather
// than a rendered grid.

export type MatrixCell = {
  modelId: string | null
  promptLabel: string | null
  total: number
  passed: number
  meanScore: number | null
  avgCostUsd: number | null
  tokensPerSec: number | null
}

export type MatrixSummaryModel = {
  cells: MatrixCell[]
  byKey: Map<string, MatrixCell>
  /** Models across the top, in first-seen order. */
  modelAxis: (string | null)[]
  /** Prompts down the side, in first-seen order. */
  promptAxis: (string | null)[]
  /** Cell keys of the per-column winners; null when nothing is comparable. */
  bestAcc: string | null
  cheapest: string | null
  fastest: string | null
}

/** True when the run varied at least one axis — otherwise there is no matrix. */
export function isMatrixRun(results: WfEvalResultDTO[]): boolean {
  return results.some((r) => r.modelId != null || r.promptLabel != null)
}

export function buildMatrixSummary(
  results: WfEvalResultDTO[],
): MatrixSummaryModel {
  const groups = new Map<string, WfEvalResultDTO[]>()
  for (const r of results) {
    const key = cellKey(r.modelId, r.promptLabel)
    const bucket = groups.get(key)
    if (bucket) bucket.push(r)
    else groups.set(key, [r])
  }

  const cells: MatrixCell[] = [...groups.values()].map((rs) => {
    const scores = rs.map((r) => r.score).filter((v): v is number => v != null)
    // Cost and speed only count runs that actually passed — a test that failed
    // (or errored) can't win "Cheapest" or "Fastest" on cost/throughput it
    // never earned. Cells with no passing runs leave both null → they can't
    // win those columns.
    const passedRs = rs.filter((r) => r.status === 'pass')
    const costs = passedRs
      .map((r) => r.runStats?.costUsd)
      .filter((v): v is number => v != null)
    // Measured throughput per result: tokens ÷ wall-clock seconds. Averaged
    // across the cell's passing runs — the live number the model actually
    // delivered, not the catalog's advertised rate.
    const speeds = passedRs
      .map((r) => {
        const t = r.runStats?.totalTokens
        const d = r.runStats?.durationMs
        return t != null && d != null && d > 0 ? t / (d / 1000) : null
      })
      .filter((v): v is number => v != null)
    const avgSpeed = mean(speeds)
    return {
      modelId: rs[0]?.modelId ?? null,
      promptLabel: rs[0]?.promptLabel ?? null,
      total: rs.length,
      passed: passedRs.length,
      meanScore: mean(scores),
      avgCostUsd: mean(costs),
      tokensPerSec: avgSpeed != null ? Math.round(avgSpeed) : null,
    }
  })

  // Per-column winners. A column with no comparable data highlights nothing.
  const best = <T,>(
    pick: (c: MatrixCell) => T | null,
    better: (a: T, b: T) => boolean,
  ): string | null => {
    let win: MatrixCell | null = null
    let winVal: T | null = null
    for (const c of cells) {
      const v = pick(c)
      if (v == null) continue
      if (winVal == null || better(v, winVal)) {
        win = c
        winVal = v
      }
    }
    return win ? cellKey(win.modelId, win.promptLabel) : null
  }

  // The two axes, in first-seen order: models across the top, prompts down the
  // side. When only one axis varies (e.g. a model sweep with a single saved
  // prompt) the grid collapses to a single row or column and still reads.
  const modelAxis: (string | null)[] = []
  const promptAxis: (string | null)[] = []
  for (const c of cells) {
    if (!modelAxis.includes(c.modelId)) modelAxis.push(c.modelId)
    if (!promptAxis.includes(c.promptLabel)) promptAxis.push(c.promptLabel)
  }

  return {
    cells,
    byKey: new Map(cells.map((c) => [cellKey(c.modelId, c.promptLabel), c])),
    modelAxis,
    promptAxis,
    // Pass rate decides accuracy; mean score only breaks ties, hence the ×1000
    // scale — a full point of pass rate must always outrank any score gap.
    bestAcc: best(
      (c) => (c.total ? (c.passed / c.total) * 1000 + (c.meanScore ?? 0) : null),
      (a, b) => a > b,
    ),
    cheapest: best(
      (c) => c.avgCostUsd,
      (a, b) => a < b,
    ),
    fastest: best(
      (c) => c.tokensPerSec,
      (a, b) => a > b,
    ),
  }
}
