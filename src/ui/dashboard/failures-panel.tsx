import { CheckCircle2 } from 'lucide-react'

import type { WfDashboardResult } from '../../server/protocol'
import { formatRelative, formatTimestamp } from '../cost'
import { WfLink } from '../nav'

import { ChartCard } from './chart-parts'
import { STATUS } from './chart-theme'

// Recent failures are a short list of distinct incidents, not a magnitude — the
// operator wants to read the error and click through, so this is a table-shaped
// panel. The failure TREND lives on the KPI tile's sparkline.

export function FailuresPanel({ data }: { data: WfDashboardResult }) {
  const failures = data.recentFailures

  return (
    <ChartCard
      title="Recent failures"
      subtitle={
        failures.length > 0
          ? 'Newest first — open one to see its trace'
          : undefined
      }
      action={
        <WfLink
          to="runs"
          className="text-xs font-medium text-neutral-500 transition hover:text-neutral-900"
        >
          View all →
        </WfLink>
      }
    >
      {failures.length === 0 ? (
        <div className="flex h-[200px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-neutral-200 text-center">
          <CheckCircle2 className="size-5" style={{ color: STATUS.good }} />
          <p className="text-sm text-neutral-500">No failures in this window</p>
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-neutral-100">
          {failures.map((run) => (
            <li key={run.id}>
              <WfLink
                to={`runs/${run.id}`}
                className="flex flex-col gap-0.5 py-2 transition hover:opacity-70"
              >
                <div className="flex items-baseline gap-2">
                  <span
                    aria-hidden
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ background: STATUS.critical }}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-neutral-900">
                    {run.workflowName}
                  </span>
                  <span
                    className="shrink-0 text-xs tabular-nums text-neutral-400"
                    title={formatTimestamp(run.createdAt)}
                  >
                    {formatRelative(run.createdAt)}
                  </span>
                </div>
                <p className="ml-3.5 truncate text-xs text-neutral-500">
                  {run.error?.trim() || 'Failed with no recorded error'}
                </p>
              </WfLink>
            </li>
          ))}
        </ul>
      )}
    </ChartCard>
  )
}
