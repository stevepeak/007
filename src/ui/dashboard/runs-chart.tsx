import { useMemo } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts'

import type { WfDashboardResult } from '../../server/protocol'

import {
  ChartCard,
  ChartEmpty,
  ChartLegend,
  ChartTooltip,
  tooltipValues,
  type LegendItem,
} from './chart-parts'
import {
  assignSeriesColors,
  axisProps,
  formatBucket,
  formatCount,
  gridProps,
} from './chart-theme'

// Run volume over time, one line per workflow — the job is telling distinct
// series apart, which is what categorical color is for.

type Row = Record<string, number> & { bucket: number }

export function RunsChart({
  data,
  onOpenRuns,
}: {
  data: WfDashboardResult
  onOpenRuns: () => void
}) {
  const { series } = data.runs
  const colors = useMemo(
    () => assignSeriesColors(series.map((s) => s.key)),
    [series],
  )

  // Recharts wants one object per x position with a field per series.
  const rows = useMemo<Row[]>(
    () =>
      data.buckets.map((bucket, i) => {
        const row = { bucket } as Row
        for (const s of series) row[s.key || '__other'] = s.points[i] ?? 0
        return row
      }),
    [data.buckets, series],
  )

  const legend: LegendItem[] = series.map((s) => ({
    key: s.key,
    label: s.label,
    color: colors.get(s.key) ?? '#000',
    value: formatCount(s.total),
  }))

  return (
    <ChartCard
      title="Runs"
      subtitle={
        data.runs.source === 'analytics'
          ? 'Executions per workflow over time (sampled)'
          : 'Executions per workflow over time'
      }
      action={
        <button
          type="button"
          onClick={onOpenRuns}
          className="text-xs font-medium text-neutral-500 transition hover:text-neutral-900"
        >
          View all →
        </button>
      }
    >
      {series.length === 0 ? (
        <ChartEmpty
          message="No runs in this window"
          hint="Trigger a workflow and its executions will show up here."
        />
      ) : (
        <>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid {...gridProps} />
              <XAxis
                dataKey="bucket"
                {...axisProps}
                tickFormatter={(v: number) => formatBucket(v, data.bucket)}
                minTickGap={24}
              />
              <YAxis
                {...axisProps}
                allowDecimals={false}
                width={44}
                tickFormatter={formatCount}
              />
              <Tooltip
                cursor={{ stroke: axisProps.stroke, strokeWidth: 1 }}
                content={(props: TooltipContentProps) => {
                  if (!props.active || !props.payload?.length) return null
                  const byKey = tooltipValues(props.payload)
                  return (
                    <ChartTooltip
                      bucketMs={Number(props.label)}
                      bucket={data.bucket}
                      // Every series at this x, so the pointer never has to
                      // land on a particular line to read its value.
                      rows={series.map((s) => ({
                        key: s.key,
                        label: s.label,
                        color: colors.get(s.key) ?? '#000',
                        value: formatCount(byKey.get(s.key || '__other') ?? 0),
                      }))}
                      total={`${formatCount(
                        series.reduce(
                          (sum, s) => sum + (byKey.get(s.key || '__other') ?? 0),
                          0,
                        ),
                      )} runs`}
                    />
                  )
                }}
              />
              {series.map((s) => (
                <Line
                  key={s.key || '__other'}
                  type="monotone"
                  dataKey={s.key || '__other'}
                  name={s.label}
                  stroke={colors.get(s.key) ?? '#000'}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  dot={false}
                  // A dot only where the pointer is; a marker on every bucket
                  // would out-weigh the line itself.
                  activeDot={{ r: 4, strokeWidth: 2, stroke: '#ffffff' }}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
          <ChartLegend items={legend} mark="line" />
        </>
      )}
    </ChartCard>
  )
}
