/**
 * Best-effort display text for a value whose shape isn't known statically.
 *
 * `String(v)` is the obvious thing to reach for and is wrong for the case that
 * actually turns up here: an object renders as the literally useless
 * `"[object Object]"`. These call sites are all places where a value of unknown
 * shape reaches the UI — a `literal` binding an author typed, an enum member, a
 * caught error, a schema fragment — so an object is not a remote possibility,
 * it is the interesting case. JSON is what a reader can act on.
 */
export function toText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? ''
    } catch {
      // Cyclic or otherwise unserialisable — fall through to the default.
      return Object.prototype.toString.call(value)
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- primitives only by here
  return String(value)
}
