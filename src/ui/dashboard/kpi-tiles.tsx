import {
  AlertTriangle,
  Activity,
  DollarSign,
  Footprints,
  ThumbsDown,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import type { WfDashboardResult } from '../../server/protocol'
import { cn } from '../cn'
import { formatTokens, formatUsd } from '../cost'

import { SPARK_NEUTRAL, Sparkline } from './chart-parts'
import { CHROME, STATUS, formatCount } from './chart-theme'

// The headline row. Four numbers is a KPI row of stat tiles, not a chart — a
// grouped bar of four unrelated measures would be unreadable and a one-bar chart
// per measure is worse.

function StatTile({
  label,
  value,
  detail,
  icon: Icon,
  accent,
  spark,
  sparkColor,
  onClick,
}: {
  label: string
  value: string
  detail?: string
  icon: LucideIcon
  /** Applied to the value when the state itself is the story (e.g. failures). */
  accent?: string
  spark?: number[]
  sparkColor?: string
  onClick?: () => void
}) {
  const body = (
    <>
      <div className="flex items-center gap-1.5">
        <Icon className="size-3.5 text-neutral-400" />
        <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
          {label}
        </span>
      </div>
      <div className="mt-2 flex items-end gap-2">
        <span
          className="text-2xl leading-none font-semibold text-neutral-900"
          style={accent ? { color: accent } : undefined}
        >
          {value}
        </span>
        {spark && spark.some((v) => v > 0) ? (
          <span className="ml-auto pb-0.5">
            <Sparkline points={spark} color={sparkColor ?? SPARK_NEUTRAL} />
          </span>
        ) : null}
      </div>
      {detail ? (
        <p className="mt-1 text-xs text-neutral-500">{detail}</p>
      ) : null}
    </>
  )
  const className = cn(
    'flex flex-col rounded-xl border border-neutral-200 bg-white p-4 text-left',
    onClick && 'transition hover:border-neutral-300 hover:shadow-sm',
  )
  return onClick ? (
    <button type="button" onClick={onClick} className={className}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  )
}

export function KpiTiles({
  data,
  onOpenRuns,
  onOpenFeedback,
}: {
  data: WfDashboardResult
  onOpenRuns: () => void
  onOpenFeedback: () => void
}) {
  const { runs, cost, feedback, steps } = data
  const failureRate = runs.total > 0 ? runs.failed / runs.total : 0
  // Only color the number when there is something to react to — a permanently
  // red tile stops meaning anything.
  const failureAccent =
    runs.failed === 0
      ? undefined
      : failureRate >= 0.1
        ? STATUS.critical
        : STATUS.serious

  return (
    <div
      className={cn(
        'grid grid-cols-2 gap-3',
        steps ? 'lg:grid-cols-5' : 'lg:grid-cols-4',
      )}
    >
      <StatTile
        label="Runs"
        icon={Activity}
        value={formatCount(runs.total)}
        detail={
          runs.inFlight > 0 ? `${formatCount(runs.inFlight)} in flight` : undefined
        }
        onClick={onOpenRuns}
      />
      <StatTile
        label="Failure rate"
        icon={AlertTriangle}
        value={runs.total > 0 ? `${(failureRate * 100).toFixed(1)}%` : '—'}
        detail={
          runs.total > 0
            ? `${formatCount(runs.failed)} of ${formatCount(runs.total)} failed`
            : 'No runs in this window'
        }
        accent={failureAccent}
        spark={runs.failedPoints}
        sparkColor={failureAccent ?? SPARK_NEUTRAL}
        onClick={onOpenRuns}
      />
      <StatTile
        label="Feedback queue"
        icon={ThumbsDown}
        value={formatCount(feedback.unacknowledged)}
        detail={
          feedback.unacknowledged > 0
            ? `${formatCount(feedback.unacknowledgedDown)} thumbs-down`
            : 'Nothing to triage'
        }
        accent={feedback.unacknowledgedDown > 0 ? STATUS.serious : undefined}
        onClick={onOpenFeedback}
      />
      <StatTile
        label="Inference cost"
        icon={DollarSign}
        value={formatUsd(cost.totalUsd)}
        detail={
          cost.totalTokens > 0
            ? `${formatTokens(cost.totalTokens)} tokens`
            : 'No agent calls'
        }
        spark={data.cost.series[0]?.points}
        sparkColor={CHROME.axis}
      />
      {/* Fifth tile ONLY when analytics is wired — the Workflows billing unit
          has no D1 equivalent, so its absence is a real state, not a zero. */}
      {steps ? (
        <StatTile
          label="Workflow steps"
          icon={Footprints}
          value={formatCount(steps.total)}
          detail={
            steps.runs > 0
              ? `${(steps.total / steps.runs).toFixed(1)} per durable run`
              : 'No durable runs'
          }
          spark={steps.points}
          sparkColor={CHROME.axis}
        />
      ) : null}
    </div>
  )
}
