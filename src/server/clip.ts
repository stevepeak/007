// Bounding what a model-facing surface returns.
//
// 007's payloads are unbounded by design — a run step's `meta` carries the full
// LLM prompt, the reasoning trace and every tool call's arguments and output, a
// workflow `graph` serializes every node — and a single unclipped read will blow
// a model's context window. Both model-facing surfaces (the System Copilot's
// tools and the MCP server) therefore return CLIPPED payloads and let the model
// drill in with a narrower follow-up call.
//
// Shared rather than duplicated because the two surfaces must agree: a limit
// that only one of them enforces is a limit that quietly stops applying the day
// someone moves a tool between them.

/** Past this many JSON characters, a single value is replaced by an excerpt. */
const DEFAULT_MAX_CHARS = 4000

/**
 * Clip one value to a bounded JSON string.
 *
 * Returns the value untouched when it fits, so small payloads stay structured
 * and only fat ones degrade to text. The replacement says how much was dropped
 * and what to do about it — a bare "…" reads as the end of the data.
 */
export function clip(value: unknown, max = DEFAULT_MAX_CHARS): unknown {
  if (value == null) return value
  const json = JSON.stringify(value)
  if (json.length <= max) return value
  return `${json.slice(0, max)}… [truncated ${json.length - max} chars — ask for a specific node to see more]`
}

/**
 * Keep the last `max` entries of a list, prefixed with a note when any were
 * dropped.
 *
 * The TAIL, not the head: every list this is used on (a run's log feed, its
 * steps) is chronological, and the end is where a failure is.
 */
export function clipTail<T>(
  items: T[],
  max: number,
  label: string,
): (T | string)[] {
  if (items.length <= max) return items
  const dropped = items.length - max
  return [
    `… [${dropped} earlier ${label} omitted of ${items.length} — narrow the request to see them]`,
    ...items.slice(dropped),
  ]
}
