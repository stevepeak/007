// The one slug core behind every derived id: connector ids, spawn tool names,
// decision choice keys and spec slugs. Each caller pins its own separator, cap
// and fallback, and those outputs are persisted, so a caller's parameters are
// frozen once they ship.

/**
 * Lowercase `text`, join its runs of ASCII letters and digits with `sep`, cut
 * the result at `max` characters, and fall back to `fallback` when nothing is
 * left. Anything outside `a-z0-9` (accents included) is a separator; a caller
 * that wants `é` → `e` folds the text before passing it in.
 *
 * The cut is the last step, so it can leave a trailing `sep`.
 */
export function slugify(args: {
  text: string
  sep: '-' | '_'
  max?: number
  fallback: string
}): string {
  const slug = args.text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join(args.sep)
    .slice(0, args.max)
  return slug || args.fallback
}
