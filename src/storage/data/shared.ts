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
