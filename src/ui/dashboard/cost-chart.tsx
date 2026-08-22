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
import { formatTokens, formatUsd } from '../cost'

import {
  ChartCard,
  ChartEmpty,
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
  gridProps,
} from './chart-theme'

// Spend per bucket, stacked by model — part-to-whole over time. The stack answers
// both questions at once: how much did this cost, and what did the money go to.

type Row = Record<string, number | string> & { bucket: number; __top: string }

function axisUsd (v: number) {
  return v >= 1 ? `$${v.toFixed(0)}` : v > 0 ? `$${v.toFixed(2)}` : '$0'
}

export function CostChart({ data }: { data: WfDashboardResult }) {
  const { series, totalUsd, totalTokens, unpricedTokens } = data.cost
  const colors = useMemo(
    () => assignSeriesColors(series.map((s) => s.key)),
    [series],
  )

  const rows = useMemo<Row[]>(
    () =>
      data.buckets.map((bucket, i) => {
        const row = { bucket, __top: '' } as Row
        // Track the highest non-zero segment so only the stack's data-end gets
        // the rounded cap — a rounded corner mid-stack reads as a gap.
        for (const s of series) {
          const v = s.points[i] ?? 0
          row[s.key] = v
          if (v > 0) row.__top = s.key
        }
        return row
      }),
    [data.buckets, series],
  )

  const legend: LegendItem[] = series.map((s) => ({
    key: s.key,
    label: s.label,
    color: colors.get(s.key) ?? '#000',
    value: formatUsd(s.total),
  }))

  return (
    <ChartCard
      title="Inference cost"
      subtitle={
        totalTokens > 0 ? (
          <>
            <span className="font-medium text-neutral-900">
              {formatUsd(totalUsd)}
            </span>{' '}
            across {formatTokens(totalTokens)} tokens
          </>
        ) : (
          'No spend in this window'
        )
      }
      footnote={
        <>
          {/* The two paths mean genuinely different things, so the caveat can't
              be static: analytics figures were priced when the tokens were
              spent, while the D1 fallback re-prices history on every read. */}
          {data.cost.pricedAtRunTime ? (
            <>
              Cost was priced when each agent call ran, so it doesn&apos;t change
              when the model catalog does. Sampled from Analytics Engine — the
              newest bucket may still be filling in.
            </>
          ) : (
            <>
              Cost is derived from recorded token usage at the model
              catalog&apos;s current prices, so historical spend re-prices when
              the catalog changes.
            </>
          )}
          {unpricedTokens > 0 ? (
            <>
              {' '}
              {formatTokens(unpricedTokens)} tokens ran on models with no
              catalog price and are excluded from the total.
            </>
          ) : null}
        </>
      }
    >
      {series.length === 0 ? (
        <ChartEmpty
          message="No priced agent calls in this window"
          hint={
            unpricedTokens > 0
              ? `${formatTokens(unpricedTokens)} tokens ran on models with no catalog price.`
              : 'Cost appears once a workflow runs an agent on a priced model.'
          }
        />
      ) : (
        <>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid {...gridProps} />
              <XAxis
                dataKey="bucket"
                {...axisProps}
                tickFormatter={(v: number) => formatBucket(v, data.bucket)}
                minTickGap={24}
              />
              <YAxis {...axisProps} width={44} tickFormatter={axisUsd} />
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
                        value: formatUsd(byKey.get(s.key) ?? 0),
                      }))}
                      total={formatUsd(
                        shown.reduce((sum, s) => sum + (byKey.get(s.key) ?? 0), 0),
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
                  stackId="cost"
                  fill={colors.get(s.key) ?? '#000'}
                  maxBarSize={24}
                  isAnimationActive={false}
                  // Custom shape rather than `radius`: it inserts the 2px
                  // surface gap between segments (white doing the separating,
                  // not a stroke) and caps only the stack's top.
                  shape={(props: BarShapeProps) => (
                    <StackedBarShape
                      {...props}
                      rounded={(props.payload as Row | undefined)?.__top === s.key}
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
