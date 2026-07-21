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
