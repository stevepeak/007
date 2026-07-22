export type FieldKind =
  | 'string'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'select'
  | 'json'
  | 'object'
  | 'array'

export function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

/** True for `{}` — used to detect a genuinely empty object schema. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return asObject(v) !== null
}
