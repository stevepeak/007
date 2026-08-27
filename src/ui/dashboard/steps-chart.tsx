import { useMemo } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type BarShapeProps,
  type TooltipContentProps,
} from 'recharts'

import type { WfDashboardResult } from '../../server/protocol'

import {
  ChartCard,
  ChartLegend,
  ChartTooltip,
  StackedBarShape,
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

// Cloudflare Workflows bills per STEP, and a graph's step count is not
// proportional to its size: every node costs enter/run/record, an iteration
// spends one step per ITEM, and a called workflow adds two more. This is the only
// place that relationship is visible — which graph is expensive, and why.
//
// Stacked by workflow rather than lined: the question is "where did the steps
// go", a part-to-whole reading, and the total height is itself the bill.

type Row = Record<string, number | string> & { bucket: number; __top: string }

export function StepsChart({ data }: { data: WfDashboardResult }) {
  const steps = data.steps
  const series = useMemo(() => steps?.series ?? [], [steps])
  const colors = useMemo(
    () => assignSeriesColors(series.map((s) => s.key)),
    [series],
  )

  const rows = useMemo<Row[]>(
    () =>
      data.buckets.map((bucket, i) => {
        const row = { bucket, __top: '' } as Row
        for (const s of series) {
          const v = s.points[i] ?? 0
          row[s.key] = v
          if (v > 0) row.__top = s.key
        }
        return row
      }),
    [data.buckets, series],
  )

  // Unconfigured analytics is ABSENT, not empty: D1 records no step counts, so
  // rendering a zeroed chart would assert something we never measured.
  if (!steps) return null

  const perRun = steps.runs > 0 ? steps.total / steps.runs : 0
  const legend: LegendItem[] = series.map((s) => ({
    key: s.key,
    label: s.label,
    color: colors.get(s.key) ?? '#000',
    value: formatCount(s.total),
  }))

  return (
    <ChartCard
      title="Workflow steps"
      subtitle={
        steps.total > 0 ? (
          <>
            <span className="font-medium text-neutral-900">
              {formatCount(steps.total)}
            </span>{' '}
            billable steps across {formatCount(steps.runs)} durable runs (
            {perRun.toFixed(1)} per run)
          </>
        ) : (
          'No durable runs in this window'
        )
      }
      footnote={
        <>
          Each node costs three steps (enter, run, record); an iteration spends
          one per item instead of one per node, and a durable sub-workflow adds
          two. {formatCount(steps.nodes)} nodes and{' '}
          {formatCount(steps.iterationItems)} iteration items produced these.
          Runs on the inline engine bill no steps and are excluded. Sampled from
          Analytics Engine, so figures are estimates.
        </>
      }
    >
      {steps.total === 0 ? (
        <p className="py-8 text-center text-xs text-neutral-400">
          Steps appear once a workflow runs on the durable engine.
        </p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart
              data={rows}
              margin={{ top: 4, right: 8, bottom: 0, left: -16 }}
            >
              <CartesianGrid {...gridProps} />
              <XAxis
                dataKey="bucket"
                {...axisProps}
                tickFormatter={(v: number) => formatBucket(v, data.bucket)}
                minTickGap={24}
              />
              <YAxis {...axisProps} width={44} tickFormatter={formatCount} />
              <Tooltip
                cursor={{ fill: 'rgba(11,11,11,0.04)' }}
                content={(props: TooltipContentProps) => {
                  if (!props.active || !props.payload?.length) return null
                  const byKey = tooltipValues(props.payload)
                  const shown = series.filter((s) => (byKey.get(s.key) ?? 0) > 0)
                  if (shown.length === 0) return null
                  return (
                    <ChartTooltip
                      bucketMs={Number(props.label)}
                      bucket={data.bucket}
                      rows={shown.map((s) => ({
                        key: s.key,
                        label: s.label,
                        color: colors.get(s.key) ?? '#000',
                        value: formatCount(byKey.get(s.key) ?? 0),
                      }))}
                      total={formatCount(
                        shown.reduce(
                          (sum, s) => sum + (byKey.get(s.key) ?? 0),
                          0,
                        ),
                      )}
                    />
                  )
                }}
              />
              {series.map((s) => (
                <Bar
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  stackId="steps"
                  fill={colors.get(s.key) ?? '#000'}
                  maxBarSize={24}
                  isAnimationActive={false}
                  shape={(props: BarShapeProps) => (
                    <StackedBarShape
                      {...props}
                      rounded={
                        (props.payload as Row | undefined)?.__top === s.key
                      }
                    />
                  )}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
          <ChartLegend items={legend} />
        </>
      )}
    </ChartCard>
  )
}
