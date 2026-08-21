import { ArrowUpRight, ChevronRight } from 'lucide-react'

import type {
  CheckResult,
  EvalCheck,
  JudgeVerdict,
  WfEvalResultRunStats,
} from '../../../server/protocol'
import { cn } from '../../cn'
import { formatDurationMs, formatTokens, formatUsd } from '../../cost'
import { WfLink } from '../../nav'
import { describeCheck } from '../check-naming'

import type { ResultRow } from './model'

// The expanded row: the goal ▸ sample breadcrumb + run link, the agent-call
// stats, and the per-check pass/fail breakdown — the drill-in detail kept out of
// the dense table until asked for.
export function ResultDetail({ row }: { row: ResultRow }) {
  const { result, setId } = row
  return (
    <div className="space-y-3 rounded-md border border-neutral-200 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          {setId && (
            <>
              <WfLink
                to={`evals/${setId}`}
                newTab
                className="text-neutral-500 hover:text-neutral-800 hover:underline"
              >
                {row.goalName}
              </WfLink>
              <ChevronRight className="size-3.5 text-neutral-300" />
              <WfLink
                to={`evals/${setId}/samples/${result.rowId}`}
                newTab
                className="font-medium text-neutral-700 hover:underline"
              >
                {row.sampleName}
              </WfLink>
            </>
          )}
        </div>
        {result.wfRunId && (
          <WfLink
            to={`runs/${result.wfRunId}`}
            className="inline-flex items-center gap-1 rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs font-medium text-neutral-700 transition hover:border-neutral-300 hover:bg-neutral-50 hover:text-neutral-900"
          >
            Open run <ArrowUpRight className="size-3.5" />
          </WfLink>
        )}
      </div>

      <RunStatsLine stats={result.runStats} />

      {/* The one place a user learns that a zero pass rate was infrastructure
          rather than their agent. An errored cell has no check verdicts to
          explain itself — this message is all it has. */}
      {row.error && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs break-words whitespace-pre-wrap text-amber-800">
          {row.error}
        </p>
      )}

      {result.checkResults.length > 0 && (
        <ul className="divide-y divide-neutral-100 rounded-md border border-neutral-100">
          {result.checkResults.map((cr, i) => (
            <CheckRow
              key={i}
              result={cr}
              check={row.checks[i]}
              to={setId ? `evals/${setId}/samples/${result.rowId}/checks/${i}` : undefined}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

// A single subdued line of the agent-call's model + measured stats — the color
// that used to sit in every card, now confined to the expanded detail.
function RunStatsLine({ stats }: { stats: WfEvalResultRunStats | null }) {
  if (!stats) return null
  const model = stats.models.length > 0 ? stats.models.join(', ') : null
  const parts = [
    stats.durationMs != null ? formatDurationMs(stats.durationMs) : null,
    stats.costUsd != null ? formatUsd(stats.costUsd) : null,
    stats.totalTokens != null ? `${formatTokens(stats.totalTokens)} tok` : null,
  ].filter(Boolean)
  if (!model && parts.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
      {model && <span className="font-medium text-neutral-700">{model}</span>}
      {parts.map((p, i) => (
        <span key={i} className="tabular-nums">
          {p}
        </span>
      ))}
    </div>
  )
}

const VERDICT_LABEL: Record<JudgeVerdict, string> = {
  strong: 'Nailed it',
  partial: 'Close enough',
  weak: 'Missed it',
}

const VERDICT_TONE: Record<JudgeVerdict, string> = {
  strong: 'bg-emerald-50 text-emerald-700',
  partial: 'bg-amber-50 text-amber-700',
  weak: 'bg-red-50 text-red-700',
}

function CheckRow({
  result,
  check,
  to,
}: {
  result: CheckResult
  check: EvalCheck | undefined
  /** Editor route for this Check, when its snapshot resolves a setId. */
  to?: string
}) {
  const label = (
    <span className="truncate text-neutral-700 group-hover:underline">
      {describeCheck(check)}
    </span>
  )
  return (
    <li className="flex items-start gap-2 px-3 py-1.5 text-sm">
      <span
        className={cn(
          'mt-0.5 select-none font-semibold',
          result.pass ? 'text-emerald-600' : 'text-red-600',
        )}
      >
        {result.pass ? '✓' : '✗'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {to ? (
            <WfLink to={to} newTab className="group flex min-w-0 items-center" title="Open this Check">
              {label}
            </WfLink>
          ) : (
            <span className="group flex min-w-0 items-center">{label}</span>
          )}
          {result.verdict ? (
            <span
              className={cn(
                'shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium',
                VERDICT_TONE[result.verdict],
              )}
            >
              {VERDICT_LABEL[result.verdict]}
            </span>
          ) : (
            // Legacy rows graded before verdicts existed carry only the float.
            result.score != null && (
              <span className="tabular-nums text-xs text-neutral-400">
                {result.score.toFixed(2)}
              </span>
            )
          )}
        </div>
        {result.reason && (
          <p className="mt-0.5 text-xs text-neutral-500">{result.reason}</p>
        )}
      </div>
    </li>
  )
}
