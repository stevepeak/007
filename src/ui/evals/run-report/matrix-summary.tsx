import { Gauge, Star, Target, Wallet } from 'lucide-react'
import { Fragment } from 'react'

import type { WfEvalResultDTO } from '../../../server/protocol'
import { cn } from '../../cn'
import { formatUsd } from '../../cost'
import { useModels } from '../../hooks'

import { cellKey, mean } from './model'

// Heatmap tint for a cell, from its pass rate: red (0) → amber (.5) → green (1).
// A soft constant alpha keeps the dark cell text readable; the hue carries the
// signal. Untested combinations (rate null) get no tint.
function heatStyle(rate: number | null): React.CSSProperties {
  if (rate == null) return {}
  const hue = Math.round(rate * 130)
  return { backgroundColor: `hsl(${hue} 65% 45% / 0.18)` }
}

// The matrix roll-up: collapses every test back into one row per {model × prompt}
// cell and reads off which cell wins on accuracy, cost, and speed. Only rendered
// for a matrix run (a plain run leaves the cell fields null → nothing to
// compare). Cost, tokens, and speed all come live from each result's `runStats`
// — speed is measured throughput (tokens ÷ wall-clock), not the model's
// advertised catalog rate, so it's present whenever a run produced stats.

type MatrixCell = {
  modelId: string | null
  promptLabel: string | null
  total: number
  passed: number
  meanScore: number | null
  avgCostUsd: number | null
  tokensPerSec: number | null
}

export function MatrixSummary({
  results,
  onHoverCell,
}: {
  results: WfEvalResultDTO[]
  /** Report the matrix cell the pointer is over (its rows highlight below). */
  onHoverCell?: (key: string | null) => void
}) {
  const models = useModels()
  const isMatrix = results.some((r) => r.modelId != null || r.promptLabel != null)
  if (!isMatrix) return null

  const modelById = new Map((models.data ?? []).map((m) => [m.id, m]))
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
    // delivered.
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

  // Per-column winners — most accurate (pass rate, ties broken by score),
  // cheapest, fastest. A column with no comparable data highlights nothing.
  const best = <T,>(
    pick: (c: MatrixCell) => T | null,
    better: (a: T, b: T) => boolean,
  ) => {
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
  const bestAcc = best(
    (c) => (c.total ? (c.passed / c.total) * 1000 + (c.meanScore ?? 0) : null),
    (a, b) => a > b,
  )
  const cheapest = best((c) => c.avgCostUsd, (a, b) => a < b)
  const fastest = best((c) => c.tokensPerSec, (a, b) => a > b)

  const modelLabel = (id: string | null) =>
    id ? (modelById.get(id)?.label ?? id) : 'Saved model'
  const promptLabel = (label: string | null) => label ?? 'Saved prompt'

  const byKey = new Map(cells.map((c) => [cellKey(c.modelId, c.promptLabel), c]))

  // The two axes, in first-seen order: models across the top, prompts down the
  // side. When only one axis varies (e.g. a model sweep with a single saved
  // prompt) the grid collapses to a single row or column and still reads.
  const modelAxis: (string | null)[] = []
  const promptAxis: (string | null)[] = []
  for (const c of cells) {
    if (!modelAxis.some((m) => m === c.modelId)) modelAxis.push(c.modelId)
    if (!promptAxis.some((p) => p === c.promptLabel)) promptAxis.push(c.promptLabel)
  }

  // The "best of" cards: one per winning column, each pointing at the cell that
  // won it.
  const highlights: {
    key: string | null
    label: string
    value: string
    Icon: typeof Target
    tone: string
  }[] = [
    {
      key: bestAcc,
      label: 'Most accurate',
      value:
        bestAcc && byKey.get(bestAcc)
          ? `${byKey.get(bestAcc)!.passed}/${byKey.get(bestAcc)!.total} passed`
          : '—',
      Icon: Target,
      tone: 'text-emerald-600',
    },
    {
      key: cheapest,
      label: 'Cheapest',
      value:
        cheapest && byKey.get(cheapest)
          ? `${formatUsd(byKey.get(cheapest)!.avgCostUsd)} / run`
          : '—',
      Icon: Wallet,
      tone: 'text-sky-600',
    },
    {
      key: fastest,
      label: 'Fastest',
      value:
        fastest && byKey.get(fastest)?.tokensPerSec != null
          ? `${byKey.get(fastest)!.tokensPerSec} tok/s`
          : '—',
      Icon: Gauge,
      tone: 'text-violet-600',
    },
  ]

  return (
    <div className="space-y-3">
      {/* What was tested: the {model × prompt} grid, shaded by pass rate. */}
      <div className="rounded-lg border border-neutral-200 bg-white p-3">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
          Tested matrix
        </div>
        <div className="overflow-x-auto">
          <div
            className="inline-grid gap-1 text-xs"
            style={{
              gridTemplateColumns: `minmax(6rem,10rem) repeat(${modelAxis.length}, minmax(4.5rem,1fr))`,
            }}
          >
            {/* Header row: empty corner + one model label per column. */}
            <div />
            {modelAxis.map((mid) => (
              <div
                key={`h-${String(mid)}`}
                className="truncate px-2 py-1 text-center font-medium text-neutral-600"
                title={modelLabel(mid)}
              >
                {modelLabel(mid)}
              </div>
            ))}
            {/* One row per prompt: prompt label + a cell per model. */}
            {promptAxis.map((pl) => (
              <Fragment key={`r-${String(pl)}`}>
                <div
                  className="flex items-center truncate px-2 py-1 font-medium text-neutral-600"
                  title={promptLabel(pl)}
                >
                  {promptLabel(pl)}
                </div>
                {modelAxis.map((mid) => {
                  const key = cellKey(mid, pl)
                  const cell = byKey.get(key)
                  if (!cell) {
                    return (
                      <div
                        key={key}
                        className="flex items-center justify-center rounded border border-dashed border-neutral-200 py-2 text-neutral-300"
                      >
                        —
                      </div>
                    )
                  }
                  const rate = cell.total ? cell.passed / cell.total : null
                  const isWin = key === bestAcc
                  const detail =
                    `${cell.passed}/${cell.total} passed` +
                    (cell.meanScore != null
                      ? ` · score ${Math.round(cell.meanScore)}`
                      : '') +
                    (cell.avgCostUsd != null
                      ? ` · ${formatUsd(cell.avgCostUsd)}/run`
                      : '') +
                    (cell.tokensPerSec != null
                      ? ` · ${cell.tokensPerSec} tok/s`
                      : '')
                  return (
                    <div
                      key={key}
                      onMouseEnter={() => onHoverCell?.(key)}
                      onMouseLeave={() => onHoverCell?.(null)}
                      title={detail}
                      style={heatStyle(rate)}
                      className={cn(
                        'flex cursor-default items-center justify-center gap-1 rounded border py-2 text-sm font-semibold tabular-nums text-neutral-800 transition',
                        isWin
                          ? 'border-emerald-400 ring-1 ring-emerald-300'
                          : 'border-neutral-200 hover:border-neutral-300',
                      )}
                    >
                      {cell.passed}/{cell.total}
                      {isWin && (
                        <Star className="size-3 fill-emerald-500 text-emerald-500" />
                      )}
                    </div>
                  )
                })}
              </Fragment>
            ))}
          </div>
        </div>
        <div className="mt-2 text-[11px] text-neutral-400">
          Shaded by pass rate · <Star className="inline size-3 -translate-y-px fill-emerald-500 text-emerald-500" /> most accurate · hover a cell to highlight its rows below
        </div>
      </div>

      {/* Best-of roll-up: one card per winning column. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {highlights.map((h) => {
          const cell = h.key ? byKey.get(h.key) : undefined
          return (
            <div
              key={h.label}
              onMouseEnter={() => cell && onHoverCell?.(h.key)}
              onMouseLeave={() => onHoverCell?.(null)}
              className={cn(
                'rounded-lg border p-3 transition',
                cell
                  ? 'border-neutral-200 bg-neutral-50/60 hover:border-emerald-300 hover:bg-emerald-50/50'
                  : 'border-dashed border-neutral-200 bg-white',
              )}
            >
              <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                <h.Icon className={cn('size-3.5', h.tone)} />
                {h.label}
              </div>
              {cell ? (
                <>
                  <div className="mt-1.5 truncate text-sm font-semibold text-neutral-900">
                    {modelLabel(cell.modelId)}
                  </div>
                  <div className="truncate text-xs text-neutral-500">
                    {promptLabel(cell.promptLabel)}
                  </div>
                  <div className={cn('mt-1 text-sm font-semibold tabular-nums', h.tone)}>
                    {h.value}
                  </div>
                </>
              ) : (
                <div className="mt-1.5 text-sm text-neutral-400">
                  Not enough data
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
