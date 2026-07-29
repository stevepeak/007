// Order-insensitive structural stringify — two payloads that differ only in
// object-key order (a fresh object vs. a JSON round-trip out of the DB) compare
// equal. Used by import to decide whether a config/graph actually changed
// before publishing a new version, so re-importing an unchanged spec is a no-op.
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stableStringify(
            (value as Record<string, unknown>)[k],
          )}`,
      )
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** True when two payloads are structurally equal ignoring key order. */
export function payloadEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
}
