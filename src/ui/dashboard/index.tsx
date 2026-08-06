import { useMemo, useState } from 'react'

import type { WfDashboardBucket } from '../../server/protocol'
import { cn } from '../cn'
import { Segmented } from '../filters'
import { useDashboard } from '../hooks-dashboard'
import { useWfNav } from '../nav'

import { CostChart } from './cost-chart'
import { FailuresPanel } from './failures-panel'
import { FeedbackPanel } from './feedback-panel'
import { KpiTiles } from './kpi-tiles'
import { ProvidersPanel } from './providers-panel'
import { RunsChart } from './runs-chart'

// The home page's operational summary: is anything failing, what is it costing,
// and is feedback piling up. It is the home tab's MAIN column — the section
// cards sit beside it as a navigation rail — so the first thing an operator sees
// is the state of the system rather than a menu.

const TIMEFRAMES = [
  { value: '24h', label: '24h', ms: 86_400_000, bucket: 'hour' },
  { value: '7d', label: '7 days', ms: 7 * 86_400_000, bucket: 'day' },
  { value: '14d', label: '14 days', ms: 14 * 86_400_000, bucket: 'day' },
  { value: '30d', label: '30 days', ms: 30 * 86_400_000, bucket: 'day' },
] as const satisfies ReadonlyArray<{
  value: string
  label: string
  ms: number
  bucket: WfDashboardBucket
}>

type TimeframeValue = (typeof TIMEFRAMES)[number]['value']

export function WfDashboard({ className }: { className?: string }) {
  const [timeframe, setTimeframe] = useState<TimeframeValue>('7d')
  const { navigate } = useWfNav()

  const frame = TIMEFRAMES.find((t) => t.value === timeframe) ?? TIMEFRAMES[1]
  // Pinned to the selected frame rather than a live clock: a `since` that moved
  // every render would be a new query key each time and refetch forever.
  const input = useMemo(
    () => ({ since: Date.now() - frame.ms, bucket: frame.bucket }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-pin only on frame change
    [frame.ms, frame.bucket],
  )
  const { data, isLoading, isFetching, error } = useDashboard(input)

  // A dashboard is a nicety on top of the launcher below it, so a failure here
  // stays quiet rather than taking the whole home page down with it.
  if (error) return null
  if (isLoading && !data) {
    return (
      <div className={className}>
        <div className="h-[420px] animate-pulse rounded-xl bg-neutral-100" />
      </div>
    )
  }
  if (!data) return null

  return (
    <div className={className}>
      {/* One filter row, above everything it scopes. */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-neutral-900">Overview</h2>
        <Segmented
          label="Timeframe"
          options={TIMEFRAMES.map((t) => ({ value: t.value, label: t.label }))}
          value={timeframe}
          onChange={setTimeframe}
        />
      </div>

      {/* Refetching holds the previous render at reduced opacity — no skeleton,
          no layout jump when the timeframe changes. */}
      <div
        className={cn(
          'flex flex-col gap-3 transition-opacity',
          isFetching && 'opacity-60',
        )}
      >
        <KpiTiles
          data={data}
          onOpenRuns={() => navigate('runs')}
          onOpenFeedback={() => navigate('feedback')}
        />
        {/* items-start so a short panel (three failures) sizes to its content
            instead of stretching to match a tall neighbour. */}
        <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-2">
          <RunsChart data={data} onOpenRuns={() => navigate('runs')} />
          <CostChart data={data} />
          <FailuresPanel data={data} />
          <FeedbackPanel data={data} />
          {/* Budgets are current, not windowed — the timeframe control above
              doesn't scope this one. */}
          <ProvidersPanel />
        </div>
      </div>
    </div>
  )
}
