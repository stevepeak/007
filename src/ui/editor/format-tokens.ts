// Number formatting for the agent Budget section. Split out of the editor so the
// rounding rules are pinned by tests — these strings are the whole point of the
// field (an author decides what to spend by reading them), and a wrong unit
// reads as plausible rather than broken.

/** Exact count with thousands separators: 288000 → "288,000". */
export const fmt = (n: number) => n.toLocaleString('en-US')

/**
 * Headline token counts, read at a glance: 2000000 → "2 Million", 131072 →
 * "131K". Used where the magnitude is the message and the digits are noise.
 */
export function humanTokens(n: number): string {
  const round = (x: number) => (Math.round(x * 10) / 10).toString()
  if (n >= 1_000_000_000) return `${round(n / 1_000_000_000)} Billion`
  if (n >= 1_000_000) return `${round(n / 1_000_000)} Million`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return fmt(n)
}

/**
 * USD, kept legible at both ends. A sub-cent budget reading "$0.00" would say
 * "this is free" when it isn't, so it becomes "<$0.01" instead.
 */
export function usd(dollars: number): string {
  if (dollars > 0 && dollars < 0.01) return '<$0.01'
  return `$${dollars.toFixed(2)}`
}
