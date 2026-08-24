// The arithmetic behind the undo stack, away from React.
//
// Two operations carry all the subtlety — appending an entry (which truncates
// the redo tail, may evict from the front, and has to tell the caller how far
// every absolute index just shifted) and deciding whether an edit merges into
// the one before it. Both are pure, and both have invariants that are easy to
// get quietly wrong, so they live here where they can be asserted.

export type UndoEntry<T> = { state: T; label: string }

/**
 * How a new edit merges with the one before it. Same `key` at the tip, inside
 * `windowMs`, replaces rather than pushes. Omit `windowMs` for no time bound
 * (drag ticks, which end when the gesture does).
 */
export type CoalesceRule = { key: string; windowMs?: number } | null

export type PushResult<T> = {
  entries: UndoEntry<T>[]
  index: number
  /**
   * How many entries fell off the FRONT. Every absolute index the caller holds
   * — `savedIndex`, most importantly — shifts down by this much.
   */
  dropped: number
}

/**
 * Append `entry` after `index`, discarding any redo tail, and evict from the
 * front once the stack exceeds `max`.
 *
 * The `dropped` count is the load-bearing part. A caller tracking "which entry
 * was the saved one" by absolute index has to subtract it, or a long editing
 * session silently reports itself as clean. Letting that index go NEGATIVE is
 * correct and deliberate: the saved state has been forgotten, so it can never
 * again equal `index`, and `dirty` stays true forever — which is the honest
 * answer once the stack no longer remembers what "saved" looked like.
 */
export function pushEntry<T>(
  entries: readonly UndoEntry<T>[],
  index: number,
  entry: UndoEntry<T>,
  max: number,
): PushResult<T> {
  const next = entries.slice(0, index + 1)
  next.push(entry)
  let dropped = 0
  if (next.length > max) {
    dropped = next.length - max
    next.splice(0, dropped)
  }
  return { entries: next, index: next.length - 1, dropped }
}

/**
 * Whether this edit continues the gesture recorded at the tip, rather than
 * starting a new one.
 *
 * Guards, in order: there must be a rule, we must be AT the tip (coalescing
 * into the middle of a stack would silently rewrite history you had stepped
 * back into), the gesture must be the same one, and it must still be inside the
 * time window when the rule sets one.
 */
export function shouldCoalesce(input: {
  rule: CoalesceRule
  atTip: boolean
  lastKey: string | null
  now: number
  lastRecordedAt: number
}): boolean {
  const { rule, atTip, lastKey, now, lastRecordedAt } = input
  if (!rule || !atTip) return false
  if (lastKey !== rule.key) return false
  if (rule.windowMs === undefined) return true
  return now - lastRecordedAt <= rule.windowMs
}
