// Shared formatting for the derived cost/usage figures (runs list, run header,
// node inspector). Cost is a dollar amount that ranges from sub-cent per node to
// dollars per run, so precision scales with magnitude; null renders as an em dash.

/** USD as `$0.00042` / `$0.012` / `$1.23`, or "—" when unknown (null). */
export function formatUsd(v: number | null | undefined): string {
  if (v == null) return '—'
  if (v === 0) return '$0'
  if (v < 0.01) return `$${v.toPrecision(2)}`
  if (v < 1) return `$${v.toFixed(3)}`
  return `$${v.toFixed(2)}`
}

/** Compact token count, e.g. `948` / `12.3k` / `1.2M`. */
export function formatTokens(v: number | null | undefined): string {
  if (v == null) return '—'
  if (v < 1000) return String(v)
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`
  return `${(v / 1_000_000).toFixed(1)}M`
}

/** Absolute timestamp as `Mar 5, 09:05 AM` (locale-formatted, 2-digit hour). */
export function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Elapsed time between two epoch-ms marks as `42s` / `3m 20s` / `1h 5m`. */
export function formatDuration(start: number, end: number | null): string {
  if (end == null) return '—'
  const secs = Math.max(0, Math.round((end - start) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ${secs % 60}s`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m`
}

/** A raw millisecond span as `820ms` / `3.4s` / `1m 5s`, or "—" when null.
 *  Sub-second precision matters for fast agent calls, so keep ms below 1s. */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  const mins = Math.floor(secs / 60)
  return `${mins}m ${Math.round(secs % 60)}s`
}

/** Wall-clock time of day as `09:05:03` (locale-formatted, seconds included). */
export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}
