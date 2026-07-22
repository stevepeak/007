import { Gauge, Target, Wallet } from 'lucide-react'

import type { WfEvalResultDTO } from '../../../server/protocol'
import { cn } from '../../cn'
import { formatUsd } from '../../cost'
import { useModels } from '../../hooks'

import { cellKey, mean } from './model'

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
    const costs = rs
      .map((r) => r.runStats?.costUsd)
      .filter((v): v is number => v != null)
    // Measured throughput per result: tokens ÷ wall-clock seconds. Averaged
    // across the cell's runs — the live number the model actually delivered.
    const speeds = rs
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
      passed: rs.filter((r) => r.status === 'pass').length,
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
  )
}
