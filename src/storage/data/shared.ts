/**
 * Build a Drizzle `set` patch from only the named keys whose value is not
 * `undefined` — the "partial update" idiom used by every `update*` function
 * across the data modules. `null` is a real value (it clears a column) and is
 * kept; `undefined` means "leave this column untouched". Naming the keys
 * explicitly keeps unrelated input fields (ids, discriminators) out of the patch.
 */
export function pickDefined<T extends object, K extends keyof T>(
  input: T,
  keys: readonly K[],
): Pick<T, K> {
  const out: Partial<Pick<T, K>> = {}
  for (const k of keys) {
    if (input[k] !== undefined) out[k] = input[k]
  }
  return out as Pick<T, K>
}

/**
 * Clamp a caller-supplied page size into `[1, max]`, falling back to `fallback`
 * when it's omitted. The paged `list*` reads all share this so their floor (1)
 * and per-query ceilings stay consistent and greppable instead of each inlining
 * its own `Math.min(Math.max(…))`.
 */
export function clampLimit(
  limit: number | undefined,
  opts: { fallback: number; max: number },
): number {
  return Math.min(Math.max(limit ?? opts.fallback, 1), opts.max)
}
