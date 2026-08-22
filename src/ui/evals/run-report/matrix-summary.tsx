import { Gauge, Star, Target, Wallet } from 'lucide-react'
import { Fragment } from 'react'

import type { WfEvalResultDTO } from '../../../server/protocol'
import { cn } from '../../cn'
import { formatUsd } from '../../cost'
import { useModels } from '../../hooks'

import {
  buildMatrixSummary,
  isMatrixRun,
  type MatrixCell,
  type MatrixSummaryModel,
} from './matrix-model'
import { cellKey } from './model'

// The matrix roll-up: the {model × prompt} grid shaded by pass rate, and a card
// per winning column. Only rendered for a matrix run (a plain run leaves the
// cell fields null → nothing to compare). The arithmetic behind it is in
// `matrix-model`; this file is how it looks.
//
// Cost, tokens, and speed all come live from each result's `runStats` — speed
// is measured throughput (tokens ÷ wall-clock), not the model's advertised
// catalog rate, so it's present whenever a run produced stats.

/** Labels for a cell's two axes, resolved against the host's model catalog. */
type Labels = {
  model: (id: string | null) => string
  prompt: (label: string | null) => string
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
  if (!isMatrixRun(results)) return null

  const modelById = new Map((models.data ?? []).map((m) => [m.id, m]))
  const matrix = buildMatrixSummary(results)
  const labels: Labels = {
    model: (id) => (id ? (modelById.get(id)?.label ?? id) : 'Saved model'),
    prompt: (label) => label ?? 'Saved prompt',
  }

  return (
    <div className="space-y-3">
      <MatrixGrid matrix={matrix} labels={labels} onHoverCell={onHoverCell} />
      <BestOfCards matrix={matrix} labels={labels} onHoverCell={onHoverCell} />
    </div>
  )
}

// Heatmap tint for a cell, from its pass rate: red (0) → amber (.5) → green (1).
// A soft constant alpha keeps the dark cell text readable; the hue carries the
// signal. Untested combinations (rate null) get no tint.
function heatStyle(rate: number | null): React.CSSProperties {
  if (rate == null) return {}
  const hue = Math.round(rate * 130)
  return { backgroundColor: `hsl(${hue} 65% 45% / 0.18)` }
}

/** What was tested: the {model × prompt} grid, shaded by pass rate. */
function MatrixGrid({
  matrix,
  labels,
  onHoverCell,
}: {
  matrix: MatrixSummaryModel
  labels: Labels
  onHoverCell?: (key: string | null) => void
}) {
  const { modelAxis, promptAxis, byKey, bestAcc } = matrix
  return (
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
              title={labels.model(mid)}
            >
              {labels.model(mid)}
            </div>
          ))}
          {/* One row per prompt: prompt label + a cell per model. */}
          {promptAxis.map((pl) => (
            <Fragment key={`r-${String(pl)}`}>
              <div
                className="flex items-center truncate px-2 py-1 font-medium text-neutral-600"
                title={labels.prompt(pl)}
              >
                {labels.prompt(pl)}
              </div>
              {modelAxis.map((mid) => {
                const key = cellKey(mid, pl)
                const cell = byKey.get(key)
                return cell ? (
                  <GridCell
                    key={key}
                    cellKeyStr={key}
                    cell={cell}
                    isWin={key === bestAcc}
                    onHoverCell={onHoverCell}
                  />
                ) : (
                  // A combination the run never tested — not a zero, an absence.
                  <div
                    key={key}
                    className="flex items-center justify-center rounded border border-dashed border-neutral-200 py-2 text-neutral-300"
                  >
                    —
                  </div>
                )
              })}
            </Fragment>
          ))}
        </div>
      </div>
      <div className="mt-2 text-[11px] text-neutral-400">
        Shaded by pass rate ·{' '}
        <Star className="inline size-3 -translate-y-px fill-emerald-500 text-emerald-500" />{' '}
        most accurate · hover a cell to highlight its rows below
      </div>
    </div>
  )
}

function GridCell({
  cellKeyStr,
  cell,
  isWin,
  onHoverCell,
}: {
  cellKeyStr: string
  cell: MatrixCell
  isWin: boolean
  onHoverCell?: (key: string | null) => void
}) {
  const rate = cell.total ? cell.passed / cell.total : null
  // Everything the cell knows, on the title — the grid itself only has room for
  // the pass count.
  const detail =
    `${cell.passed}/${cell.total} passed` +
    (cell.meanScore != null ? ` · score ${Math.round(cell.meanScore)}` : '') +
    (cell.avgCostUsd != null ? ` · ${formatUsd(cell.avgCostUsd)}/run` : '') +
    (cell.tokensPerSec != null ? ` · ${cell.tokensPerSec} tok/s` : '')
  return (
    <div
      onMouseEnter={() => onHoverCell?.(cellKeyStr)}
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
      {isWin && <Star className="size-3 fill-emerald-500 text-emerald-500" />}
    </div>
  )
}

/** Best-of roll-up: one card per winning column, pointing at the cell that won it. */
function BestOfCards({
  matrix,
  labels,
  onHoverCell,
}: {
  matrix: MatrixSummaryModel
  labels: Labels
  onHoverCell?: (key: string | null) => void
}) {
  const { byKey, bestAcc, cheapest, fastest } = matrix
  const highlights = [
    {
      key: bestAcc,
      label: 'Most accurate',
      value: bestAcc
        ? `${byKey.get(bestAcc)?.passed}/${byKey.get(bestAcc)?.total} passed`
        : '—',
      Icon: Target,
      tone: 'text-emerald-600',
    },
    {
      key: cheapest,
      label: 'Cheapest',
      value: cheapest
        ? `${formatUsd(byKey.get(cheapest)?.avgCostUsd ?? null)} / run`
        : '—',
      Icon: Wallet,
      tone: 'text-sky-600',
    },
    {
      key: fastest,
      label: 'Fastest',
      value:
        fastest && byKey.get(fastest)?.tokensPerSec != null
          ? `${byKey.get(fastest)?.tokensPerSec} tok/s`
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
                  {labels.model(cell.modelId)}
                </div>
                <div className="truncate text-xs text-neutral-500">
                  {labels.prompt(cell.promptLabel)}
                </div>
                <div
                  className={cn('mt-1 text-sm font-semibold tabular-nums', h.tone)}
                >
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
