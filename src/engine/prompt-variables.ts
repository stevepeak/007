// `${token}` interpolation contract, shared by prompt variable inference and the
// agent node's runtime substitution. A variable name is `\w+`.
export const PROMPT_VARIABLE_RE = /\$\{(\w+)\}/g

/** Distinct `${token}` variable names referenced in a prompt body, in order. */
export function inferPromptVariables(body: string): string[] {
  const seen = new Set<string>()
  for (const m of body.matchAll(PROMPT_VARIABLE_RE)) {
    seen.add(m[1])
  }
  return [...seen]
}

/**
 * Substitute `${token}` variables in a prompt body against `vars`. Unknown
 * tokens are left intact so the author sees them at runtime rather than
 * silently producing empty strings. Shares `PROMPT_VARIABLE_RE` with
 * `inferPromptVariables` so inference and substitution can never drift.
 */
export function substitutePromptVariables(
  body: string,
  vars: Record<string, string | undefined>,
): string {
  return body.replaceAll(PROMPT_VARIABLE_RE, (match, key: string) => {
    return vars[key] ?? match
  })
}

/**
 * Fill a `${token}` template for USER-FACING text (a tool's `statusLabel`, a
 * node's `progressNote`) from an arbitrary value bag. Differs from
 * `substitutePromptVariables` in two deliberate ways suited to end-user copy:
 * a missing/nullish token resolves to '' (never a raw `${…}` leaking to the
 * user), and non-string values are coerced (objects JSON-stringified). Shares
 * `PROMPT_VARIABLE_RE` so the token grammar can't drift.
 */
export function interpolateUserText(
  template: string,
  vars: unknown,
): string {
  const bag =
    vars && typeof vars === 'object'
      ? (vars as Record<string, unknown>)
      : {}
  return template.replaceAll(PROMPT_VARIABLE_RE, (_match, key: string) => {
    const v = bag[key]
    if (v == null) return ''
    if (typeof v === 'string') return v
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    return JSON.stringify(v)
  })
}
