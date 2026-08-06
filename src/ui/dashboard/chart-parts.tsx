import type { ReactNode } from 'react'
import type { BarShapeProps, TooltipContentProps } from 'recharts'

import type { WfDashboardBucket } from '../../server/protocol'
import { cn } from '../cn'

import { CHROME, formatBucketLong } from './chart-theme'

// The pieces every dashboard panel is built from — card chrome, the legend, the
// hover readout, and the empty state. Kept together so the four panels can't
// drift into four slightly-different treatments of the same furniture.

/** A panel surface. Matches the card idiom used across the SDK. */
export function ChartCard({
  title,
  subtitle,
  action,
  footnote,
  children,
  className,
}: {
  title: string
  subtitle?: ReactNode
  /** Top-right slot — a link out, usually. */
  action?: ReactNode
  /** Small caveat under the plot (e.g. how cost is derived). */
  footnote?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        'flex flex-col rounded-xl border border-neutral-200 bg-white p-5',
        className,
      )}
    >
      <div className="mb-4 flex items-start gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-neutral-900">{title}</h2>
          {subtitle ? (
            <p className="mt-0.5 text-xs text-neutral-500">{subtitle}</p>
          ) : null}
        </div>
        {action ? <div className="ml-auto shrink-0">{action}</div> : null}
      </div>
      {children}
      {footnote ? (
        <p className="mt-3 text-[11px] leading-relaxed text-neutral-400">
          {footnote}
        </p>
      ) : null}
    </section>
  )
}

/** Shown in place of a plot when the window holds nothing to chart. */
export function ChartEmpty({
  message,
  hint,
  height = 200,
}: {
  message: string
  hint?: string
  height?: number
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-neutral-200 text-center"
      style={{ height }}
    >
      <p className="text-sm text-neutral-500">{message}</p>
      {hint ? <p className="text-xs text-neutral-400">{hint}</p> : null}
    </div>
  )
}

export type LegendItem = {
  key: string
  label: string
  color: string
  /** Rendered beside the label — the series' window total. */
  value: string
}

/**
 * The identity channel. Always present for two or more series, and it carries
 * each series' total as VISIBLE text rather than leaving the number to hover —
 * three of the categorical hues sit under 3:1 on white, and a legible value
 * beside a colored key is what makes that safe.
 *
 * `mark` mirrors the chart's own geometry: a line key for lines, a swatch for
 * bars and areas.
 */
export function ChartLegend({
  items,
  mark = 'rect',
}: {
  items: LegendItem[]
  mark?: 'rect' | 'line'
}) {
  if (items.length < 2) return null
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
      {items.map((item) => (
        <li key={item.key || item.label} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={cn('shrink-0', mark === 'line' ? 'h-0.5 w-3' : 'size-2.5 rounded-sm')}
            style={{ background: item.color }}
          />
          <span className="max-w-[14rem] truncate text-xs text-neutral-600">
            {item.label}
          </span>
          <span className="text-xs tabular-nums text-neutral-900">
            {item.value}
          </span>
        </li>
      ))}
    </ul>
  )
}

export type TooltipRow = { key: string; label: string; color: string; value: string }

/**
 * Flatten a recharts tooltip payload into `dataKey → number`.
 *
 * Recharts types a payload entry's `dataKey` as a full accessor union and its
 * `value` as string | number | array, so both get narrowed here once rather than
 * at each of the three call sites. A non-numeric value can't occur for these
 * charts (every series is a count or a dollar amount) and coerces to 0.
 */
export function tooltipValues(
  payload: TooltipContentProps['payload'],
): Map<string, number> {
  const out = new Map<string, number>()
  for (const entry of payload ?? []) {
    const key = entry.dataKey
    if (typeof key !== 'string' && typeof key !== 'number') continue
    out.set(String(key), Number(entry.value) || 0)
  }
  return out
}

/**
 * The hover readout. Values lead and labels follow — the reader already knows
 * which series they're pointing at and wants the number. Series names come from
 * user-authored workflow names and provider model ids, so they're rendered as
 * React text nodes, never interpolated markup.
 */
export function ChartTooltip({
  bucketMs,
  bucket,
  rows,
  total,
}: {
  bucketMs: number
  bucket: WfDashboardBucket
  rows: TooltipRow[]
  /** Optional summary line under the rows. */
  total?: string
}) {
  return (
    <div className="pointer-events-none rounded-lg border border-neutral-200 bg-white px-3 py-2 shadow-lg">
      <p className="mb-1.5 text-[11px] font-medium text-neutral-500">
        {formatBucketLong(bucketMs, bucket)}
      </p>
      <ul className="flex flex-col gap-1">
        {rows.map((r) => (
          <li key={r.key || r.label} className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-0.5 w-3 shrink-0"
              style={{ background: r.color }}
            />
            <span className="min-w-0 flex-1 truncate text-xs text-neutral-500">
              {r.label}
            </span>
            <span className="text-xs font-medium tabular-nums text-neutral-900">
              {r.value}
            </span>
          </li>
        ))}
      </ul>
      {total ? (
        <p className="mt-1.5 border-t border-neutral-100 pt-1.5 text-right text-xs font-medium tabular-nums text-neutral-900">
          {total}
        </p>
      ) : null}
    </div>
  )
}

/**
 * A stacked-bar segment: the fill inset by the surface gap so neighbouring
 * segments are separated by white rather than by a stroke, with a 4px rounded
 * cap on the topmost segment only (the data-end) and square corners at the
 * baseline.
 */
export function StackedBarShape({
  x = 0,
  y = 0,
  width = 0,
  height = 0,
  fill,
  rounded,
}: Pick<BarShapeProps, 'x' | 'y' | 'width' | 'height' | 'fill'> & {
  /** True when this segment is the highest non-zero one in its column. */
  rounded?: boolean
}) {
  if (height <= 0 || width <= 0) return null
  // The gap eats into the segment's top; below ~1px of fill there's nothing
  // meaningful left to draw, so skip it rather than render a sliver.
  const gap = Math.min(2, Math.max(0, height - 1))
  const top = y + gap
  const h = height - gap
  const r = rounded ? Math.min(4, h, width / 2) : 0
  const path = r
    ? `M${x},${top + h} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + width - r},${top} Q${x + width},${top} ${x + width},${top + r} L${x + width},${top + h} Z`
    : `M${x},${top} h${width} v${h} h${-width} Z`
  return <path d={path} fill={fill} />
}

/** A bare trend line for stat tiles — no axes, no hover, just the shape. */
export function Sparkline({
  points,
  color,
  width = 72,
  height = 22,
}: {
  points: number[]
  color: string
  width?: number
  height?: number
}) {
  if (points.length < 2) return null
  const max = Math.max(...points, 1)
  const stepX = width / (points.length - 1)
  const d = points
    .map((v, i) => {
      const x = i * stepX
      // Inset by the stroke's half-width so the extremes aren't clipped.
      const y = height - 1 - (v / max) * (height - 2)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      className="shrink-0 overflow-visible"
    >
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Neutral ink for a sparkline with nothing notable in it. */
export const SPARK_NEUTRAL = CHROME.axis
