// Shape guards for values whose type isn't known statically (parsed JSON, node
// outputs, schema fragments). Engine-level so every layer shares one definition
// of "a plain object".

/** True for a non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `value` as a record, or `undefined` when it is not one. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}
