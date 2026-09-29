// Canonical structural stringify — the one answer to "did this thing change?".
//
// Four subsystems were each carrying their own copy: wf-spec import (publish a
// new version or not), the connector tool-schema drift hash, the hidden
// eval-wrapper drift check, and the persisted eval-snapshot hash. Every copy
// sorted object keys the same way and then disagreed about the single case that
// decides the answer — how an explicitly-`undefined` key compares to an absent
// one — so the same pair of objects could read as "changed" in one subsystem and
// "unchanged" in another. That divergence is the bug; the sorting was never the
// interesting part.
//
// It lives in `engine` because engine is the bottom of the stack (it imports
// nothing from `src/`), so `storage`, `connectors` and `eval` can all reach it
// without any of them depending on another. Same reasoning as
// `connector-tool-id.ts`.

/**
 * What an `undefined` becomes. There is no `'null'` mode: `storage/spec`'s copy
 * used to map `undefined → null`, which made `{a: undefined}` and `{}` compare
 * unequal and re-published an unchanged spec on import. That was the latent bug,
 * not a semantic anyone wanted, so it is not offered here.
 *
 * • `drop` — an `undefined` object value means the key is ABSENT. This is JSON
 *   round-trip semantics: a value that has been through the database cannot
 *   carry an `undefined` key, so a fresh object that does must still compare
 *   equal to it. Every drift check wants this.
 *
 * • `literal` — the key is kept and its value renders as the bare text
 *   `undefined`. Not JSON, and not something to reach for: it exists because
 *   {@link hashEvalSnapshot} SHA-256s this output into a hash that is already
 *   persisted and compared across runs, so its wire format is frozen.
 */
export type UndefinedMode = 'drop' | 'literal'

export type StableStringifyOptions = {
  /** Defaults to `'drop'` — the right answer for "did the meaning change?". */
  undefinedKeys?: UndefinedMode
}

/**
 * Deterministic JSON-ish text with object keys sorted at every depth, so two
 * values that differ only in property insertion order produce the same string.
 *
 * Not a JSON serializer — the output is a comparison/hash key, never something
 * to parse back. Under `'literal'` it is not even valid JSON, on purpose.
 */
export function stableStringify(
  value: unknown,
  opts?: StableStringifyOptions,
): string {
  return write(value, opts?.undefinedKeys ?? 'drop')
}

/** True when two values are structurally equal ignoring object-key order. */
export function stableEqual(
  a: unknown,
  b: unknown,
  opts?: StableStringifyOptions,
): boolean {
  return stableStringify(a, opts) === stableStringify(b, opts)
}

function write(value: unknown, mode: UndefinedMode): string {
  if (value === undefined) {
    // Reached for an array element or a top-level call — an `undefined` OBJECT
    // VALUE is handled by the key filter below, which is the case the mode is
    // named for. Rendering it rather than eliding it keeps `[undefined]` and
    // `[]` distinguishable and keeps the return type honest; the four previous
    // copies returned JS `undefined` here and relied on template coercion.
    return 'undefined'
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => write(v, mode)).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => mode === 'literal' || v !== undefined)
    // Compared with `<`/`>` rather than `localeCompare`, which is
    // locale-sensitive: a hash that depends on the runtime's collation is not a
    // stable hash.
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${write(v, mode)}`)
  return `{${entries.join(',')}}`
}
