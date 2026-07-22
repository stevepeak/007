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
