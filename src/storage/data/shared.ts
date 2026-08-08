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

/**
 * How many ids one `inArray(...)` may bind. D1 caps a prepared statement at 100
 * bound parameters, and a statement that exceeds it fails outright with
 * `D1_ERROR: too many SQL variables` — 90 leaves headroom for the other bound
 * values riding along in the same statement (filters, limit, offset).
 */
export const ID_CHUNK_SIZE = 90

/**
 * Split a list into `size`-element chunks. Shared so the reads that fan an id
 * list into `inArray(...)` and the deletes that do the same all cut at one
 * greppable ceiling, instead of each inlining its own slice loop and its own
 * guess at the budget (the write paths in `runs-logs.ts` / `models.ts` predate
 * this and derive their own row-count caps, which is a different calculation —
 * params per ROW, not per id).
 */
export function chunk<T>(items: readonly T[], size = ID_CHUNK_SIZE): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

/**
 * Run `query` once per chunk of `ids` and concatenate the rows, so a
 * caller-sized id list can't push a statement past D1's parameter ceiling.
 *
 * CORRECTNESS RULE: concatenating is only sound when every result row belongs
 * to exactly one chunk — i.e. the caller's downstream fold (or the query's own
 * `GROUP BY`) is keyed by the CHUNKED column. That holds for an id lookup and
 * for a `GROUP BY <chunked column>` aggregate. It does NOT hold for a global
 * `ORDER BY … LIMIT` (each chunk returns its own top-N) or for an aggregate
 * grouped by some other column (the same group spans chunks and needs merging).
 * Check that before reaching for this.
 */
export async function selectChunked<T, R>(
  ids: readonly T[],
  query: (chunk: T[]) => Promise<R[]>,
  size = ID_CHUNK_SIZE,
): Promise<R[]> {
  if (ids.length === 0) return []
  if (ids.length <= size) return await query([...ids])
  const results = await Promise.all(chunk(ids, size).map(query))
  return results.flat()
}
