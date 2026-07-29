// Slug helpers for the portable spec. A slug is the stable, cross-environment
// identity of an agent/workflow (see `wfAgent.slug`). These derive one from a
// display name for backfill, and de-collide within a batch.

// Combining diacritical marks, stripped after an NFKD decomposition so "Café"
// slugs to "cafe". The Unicode property escape avoids an explicit code-point
// range (and any invisible combining glyphs) in the source.
const COMBINING_MARKS = /\p{Diacritic}/gu

/**
 * Derive a URL/filename-safe slug from a display name: lowercased, non
 * alphanumerics collapsed to single hyphens, trimmed. Falls back to `item`
 * when a name has no usable characters (e.g. all punctuation), so the caller
 * never gets an empty slug to de-collide.
 */
export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replaceAll(COMBINING_MARKS, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
  return base || 'item'
}

/**
 * Return `base`, or `base-2`, `base-3`, … — the first form not already in
 * `taken`. Mutates `taken` to include the chosen slug so repeated calls in a
 * loop stay unique.
 */
export function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base)
    return base
  }
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) {
      taken.add(candidate)
      return candidate
    }
  }
}
