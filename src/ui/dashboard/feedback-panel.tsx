import { ThumbsDown, ThumbsUp } from 'lucide-react'
import { useMemo } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type BarShapeProps,
  type TooltipContentProps,
} from 'recharts'

import type { WfDashboardResult } from '../../server/protocol'
import { WfLink } from '../nav'

import {
  ChartCard,
  ChartEmpty,
  ChartTooltip,
  StackedBarShape,
  tooltipValues,
} from './chart-parts'
import { CHROME, STATUS, axisProps, formatBucket, formatCount, gridProps } from './chart-theme'

// Thumbs are polarity, not identity, so this is a diverging bar centred on zero:
// up above the line, down below it. That shape answers "which way is sentiment
// going" without the reader having to compare two stacked heights.
//
// The two colors are the reserved status steps, not categorical slots — and
// because a status must never rest on hue alone, each side carries its own icon
// and label.

type Row = { bucket: number; up: number; down: number }

export function FeedbackPanel({ data }: { data: WfDashboardResult }) {
  const { feedback } = data
  const rows = useMemo<Row[]>(
    () =>
      data.buckets.map((bucket, i) => ({
        bucket,
        up: feedback.upPoints[i] ?? 0,
        // Negative so the bar grows downward from the zero line.
        down: -(feedback.downPoints[i] ?? 0),
      })),
    [data.buckets, feedback.upPoints, feedback.downPoints],
  )
  const hasTrend = feedback.up > 0 || feedback.down > 0

  return (
    <ChartCard
      title="Feedback"
      subtitle="Thumbs on AI answers, and what's left to triage"
      action={
        <WfLink
          to="feedback"
          className="text-xs font-medium text-neutral-500 transition hover:text-neutral-900"
        >
          Triage →
        </WfLink>
      }
      footnote="Clearing a thumb deletes it and editing one re-opens it, so this is the current state of feedback rather than a history of it."
    >
      <div className="mb-4 flex items-center gap-6">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
            Unacknowledged
          </p>
          <p
            className="mt-1 text-3xl leading-none font-semibold"
            style={{
              color:
                feedback.unacknowledged > 0 ? CHROME.primary : CHROME.muted,
            }}
          >
            {formatCount(feedback.unacknowledged)}
          </p>
        </div>
        <ul className="flex flex-col gap-1.5">
          <li className="flex items-center gap-1.5">
            <ThumbsUp className="size-3.5" style={{ color: STATUS.good }} />
            <span className="text-xs text-neutral-500">Up</span>
            <span className="text-xs font-medium tabular-nums text-neutral-900">
              {formatCount(feedback.up)}
            </span>
          </li>
          <li className="flex items-center gap-1.5">
            <ThumbsDown
              className="size-3.5"
              style={{ color: STATUS.critical }}
            />
            <span className="text-xs text-neutral-500">Down</span>
            <span className="text-xs font-medium tabular-nums text-neutral-900">
              {formatCount(feedback.down)}
            </span>
          </li>
        </ul>
      </div>

      {!hasTrend ? (
        <ChartEmpty
          message="No thumbs in this window"
          hint={
            feedback.unacknowledged > 0
              ? 'The queue above holds older feedback.'
              : undefined
          }
          height={140}
        />
      ) : (
        <ResponsiveContainer width="100%" height={140}>
          <BarChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
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
              // The sign is the axis's direction, not part of the count.
              tickFormatter={(v: number) => formatCount(Math.abs(v))}
            />
            <ReferenceLine y={0} stroke={CHROME.axis} strokeWidth={1} />
            <Tooltip
              cursor={{ fill: 'rgba(11,11,11,0.04)' }}
              content={(props: TooltipContentProps) => {
                if (!props.active || !props.payload?.length) return null
                const byKey = tooltipValues(props.payload)
                return (
                  <ChartTooltip
                    bucketMs={Number(props.label)}
                    bucket={data.bucket}
                    rows={[
                      {
                        key: 'up',
                        label: 'Thumbs up',
                        color: STATUS.good,
                        value: formatCount(byKey.get('up') ?? 0),
                      },
                      {
                        key: 'down',
                        label: 'Thumbs down',
                        color: STATUS.critical,
                        value: formatCount(Math.abs(byKey.get('down') ?? 0)),
                      },
                    ]}
                  />
                )
              }}
            />
            <Bar
              dataKey="up"
              name="Thumbs up"
              fill={STATUS.good}
              maxBarSize={24}
              isAnimationActive={false}
              shape={(p: BarShapeProps) => <StackedBarShape {...p} rounded />}
            />
            <Bar
              dataKey="down"
              name="Thumbs down"
              fill={STATUS.critical}
              maxBarSize={24}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  )
}
