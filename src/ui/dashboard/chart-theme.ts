import type { WfDashboardBucket } from '../../server/protocol'

// The one place the dashboard's charts get their color, chrome and shared
// geometry, so four panels read as a single system rather than four products.
//
// The categorical order below is the CVD-safety mechanism, not decoration: this
// exact sequence was validated (OKLab ΔE under simulated protanopia/deuteranopia)
// against the white card surface these charts render on — worst adjacent pair
// 9.1 (target ≥ 8), worst normal-vision pair 19.6 (floor ≥ 15). Reordering it or
// appending a ninth "just one more" hue breaks that guarantee, which is why a
// ninth series folds into OTHER (see `collapseSeries` in storage) instead.
//
// Aqua, yellow and magenta sit below 3:1 against white. That is allowed here
// only because every chart carries its values as VISIBLE legend numbers rather
// than hiding them behind hover — identity is never color-alone.
//
// 007's UI is light-only (there is not one `dark:` class in the SDK), so these
// are light-surface steps. A dark mode would need its own validated steps, not
// an automatic flip.

/** Categorical slots, in fixed order. Never cycled, never extended. */
export const SERIES_COLORS = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
] as const

/** De-emphasis gray for the folded "Other" series — never a categorical slot. */
export const OTHER_COLOR = '#898781'

/**
 * Reserved state colors. Never reused as a series hue, and always shipped with
 * an icon + label so a status never rests on color alone.
 */
export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const

/** Chart chrome — recessive by construction; the data is the only loud thing. */
export const CHROME = {
  surface: '#ffffff',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  muted: '#898781',
  secondary: '#52514e',
  primary: '#0b0b0b',
} as const

/** Width of the surface gap that separates touching marks. */
export const SURFACE_GAP = 2

/**
 * Map series keys to colors so a color follows its ENTITY, not its rank.
 *
 * Series arrive ranked by volume, but ranking moves when the timeframe changes —
 * painting by array index would recolor every workflow the moment traffic
 * shifted, which is exactly the thing that makes a dashboard untrustworthy at a
 * glance. So the slot comes from a hash of the key, with linear probing to keep
 * two series in the same view off the same slot. Same workflow, same color,
 * regardless of where it ranks today.
 */
export function assignSeriesColors(keys: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const taken = new Set<number>()
  // Sorted so probing order (and therefore the outcome) never depends on rank.
  for (const key of [...keys].sort()) {
    if (key === '') {
      out.set(key, OTHER_COLOR)
      continue
    }
    let hash = 0
    for (let i = 0; i < key.length; i++) {
      hash = (hash * 31 + key.charCodeAt(i)) >>> 0
    }
    let slot = hash % SERIES_COLORS.length
    for (let i = 0; i < SERIES_COLORS.length && taken.has(slot); i++) {
      slot = (slot + 1) % SERIES_COLORS.length
    }
    taken.add(slot)
    out.set(key, SERIES_COLORS[slot] as string)
  }
  return out
}

/** Axis tick label for a bucket start, sized to the bucket. */
export function formatBucket(ms: number, bucket: WfDashboardBucket): string {
  return new Date(ms).toLocaleString(undefined, {
    ...(bucket === 'hour'
      ? { hour: '2-digit', minute: '2-digit' }
      : { month: 'short', day: 'numeric' }),
  })
}

/** Full bucket label for tooltips, where the extra context is worth the width. */
export function formatBucketLong(
  ms: number,
  bucket: WfDashboardBucket,
): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(bucket === 'hour' ? { hour: '2-digit', minute: '2-digit' } : {}),
  })
}

/** Compact whole-number count for axis ticks: `948` / `12.3k` / `1.2M`. */
export function formatCount(v: number): string {
  if (v < 1000) return String(Math.round(v))
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`
  return `${(v / 1_000_000).toFixed(1)}M`
}

/** Shared axis styling — hairline, one step off surface, deliberately recessive. */
export const axisProps = {
  stroke: CHROME.axis,
  tick: { fill: CHROME.muted, fontSize: 11 },
  tickLine: false,
  axisLine: false,
} as const

export const gridProps = {
  stroke: CHROME.grid,
  strokeWidth: 1,
  vertical: false,
} as const
