import type { WfEvalResultDTO, WfEvalResultRunStats } from '../server/protocol'

// The eval report's arithmetic, with no reader attached to it.
//
// Every figure here used to live under `src/ui/evals/run-report/`, computed on
// the way into a grid. That was fine while the console was the only reader — and
// it stopped being fine the moment `get_eval_run` started answering "which model
// won?" over MCP, because the honest answer was that nothing outside the browser
// could work it out. `run_eval` caps a sweep at 100 cells and the MCP report
// returns 60 rows worst-first, so the winner of a full matrix was not merely
// unaggregated: it was not in the payload at all.
//
// So the roll-up moved down here, where both readers derive it from the same
// `WfEvalResultDTO[]`, and a matrix summary rendered in the console and one read
// by a model cannot disagree about who won.
//
// ── Two rules that the numbers depend on ─────────────────────────────────────
//
//   • `mean` averages only over the results that REPORTED the figure. A cell
//     whose provider never answered has no cost, and folding it in as a zero
//     would make an outage look cheap.
//   • Cost and speed count only PASSING runs. A test that failed can't win
//     "cheapest" on money it never earned, and the fastest way to produce a
//     wrong answer is not a finding anyone wants crowned.

export type MatrixCell = {
  modelId: string | null
  promptLabel: string | null
  total: number
  passed: number
  meanScore: number | null
  avgCostUsd: number | null
  tokensPerSec: number | null
}

export type MatrixSummary = {
  cells: MatrixCell[]
  /** Models across the top, in first-seen order. */
  modelAxis: (string | null)[]
  /** Prompts down the side, in first-seen order. */
  promptAxis: (string | null)[]
  /** Cell keys of the per-column winners; null when nothing is comparable. */
  bestAcc: string | null
  cheapest: string | null
  fastest: string | null
}

/** Mean over the values that exist; null when none do. */
export function mean(vals: number[]): number | null {
  return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null
}

/**
 * Stable identity for a matrix cell — one {model × prompt} combination.
 *
 * Shared by the matrix summary (which cell won a column) and the results table
 * (which rows belong to a cell), so hovering a summary card can light up its
 * rows — and so an MCP reader can join a named winner back to its results.
 */
export function cellKey(
  modelId: string | null,
  promptLabel: string | null,
): string {
  return `${modelId ?? ''} ${promptLabel ?? ''}`
}

/** True when the run varied at least one axis — otherwise there is no matrix. */
export function isMatrixRun(results: WfEvalResultDTO[]): boolean {
  return results.some((r) => r.modelId != null || r.promptLabel != null)
}

/**
 * Collapse every result into one row per {model × prompt} cell, and work out
 * which cell wins on accuracy, cost and speed.
 */
export function buildMatrixSummary(
  results: WfEvalResultDTO[],
): MatrixSummary {
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

/** Run-level averages over the agent calls, plus what the sweep actually cost. */
export type AgentCallTotals = {
  /** Results that reported stats at all — the denominator of the averages. */
  count: number
  avgDurationMs: number | null
  avgCostUsd: number | null
  /** The bill. Null when no result reported a cost. */
  totalCostUsd: number | null
  totalTokens: number | null
}

/**
 * Roll the per-result agent-call stats up into run-level figures.
 *
 * Everything is agent-call-scoped upstream in `loadRunStats`, so judge/test
 * grading never enters these numbers — which is what makes `totalCostUsd` the
 * cost of the thing under test rather than the cost of measuring it.
 */
export function agentCallTotals(
  results: WfEvalResultDTO[],
): AgentCallTotals {
  const stats = results
    .map((r) => r.runStats)
    .filter((s): s is WfEvalResultRunStats => s != null)
  const nums = (pick: (s: WfEvalResultRunStats) => number | null) => {
    return stats.map(pick).filter((v): v is number => v != null)
  }
  const costs = nums((s) => s.costUsd)
  const tokens = nums((s) => s.totalTokens)
  return {
    count: stats.length,
    avgDurationMs: mean(nums((s) => s.durationMs)),
    avgCostUsd: mean(costs),
    totalCostUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
    totalTokens: tokens.length > 0 ? tokens.reduce((a, b) => a + b, 0) : null,
  }
}
