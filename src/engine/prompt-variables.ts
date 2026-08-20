// `${token}` interpolation contract, shared by prompt variable inference, the
// agent node's runtime substitution, and the editor's chip decorations.
//
// A variable name is `[\w-]+` — letters, digits, `_` and `-`. The bag is a plain
// `Record<string, …>`, so a hyphen costs nothing to accept and authors reach for
// it. Spaces are deliberately excluded: a space-tolerant token swallows prose
// after a stray `${`, turning a typo into a silently mangled prompt.
//
// The name may carry BACKSLASH ESCAPES (`${my\_var}`). Prompt bodies are stored
// as Markdown, and `@tiptap/markdown`'s serializer escapes every
// markdown-significant character unconditionally — including `_`. Tolerating
// that here is what makes an underscore variable work at all (ART-49): the
// editor also cleans the escape on save (`unescapePromptVariables`), but a name
// whose `_` sits at the edge (`${_foo}`) can only survive the Markdown round
// trip escaped, so the engine has to read both forms. Use `promptVariableName`
// on the capture — never the raw group — to get the name itself.
export const PROMPT_VARIABLE_RE = /\$\{((?:\\.|[\w-])+)\}/g

/**
 * Any `${…}` run, well-formed name or not. The editor uses this to TELL an
 * author that `${my var}` is not a variable, rather than leaving it unchipped
 * and shipping it to the model as literal text. Never used for substitution —
 * only `PROMPT_VARIABLE_RE` decides what is actually a variable.
 */
export const PROMPT_TOKEN_RE = /\$\{([^{}]*)\}/g

/** Whether `name` — an unescaped `${…}` body — is a usable variable name. */
export function isPromptVariableName(name: string): boolean {
  return /^[\w-]+$/.test(name)
}

/**
 * The variable name a `${…}` body denotes, Markdown escapes removed — or `null`
 * if it isn't a variable at all (`${my var}`, `${a\*b}`), in which case callers
 * must leave the text exactly as the author wrote it.
 */
export function promptVariableName(raw: string): string | null {
  const name = raw.includes('\\') ? raw.replaceAll(/\\(.)/g, '$1') : raw
  return isPromptVariableName(name) ? name : null
}

/** A `${…}` run whose body may carry backslash escapes. See `unescapePromptVariables`. */
const ESCAPED_TOKEN_RE = /\$\{((?:\\.|[^{}\\])*)\}/g

/**
 * Strip the Markdown editor's backslash escapes from inside `${…}` tokens, so
 * what gets stored is the `${my_var}` the author actually typed rather than the
 * serializer's `${my\_var}`. Runs where the Markdown leaves the editor.
 *
 * The engine reads both forms, so this is cosmetic — it keeps stored configs and
 * the text the model sees free of stray backslashes. Only a token whose
 * unescaped body is a valid variable name is rewritten, so `${a \* b}` and other
 * non-variable braces keep their text verbatim. A name with a LEADING or
 * TRAILING `_` is left escaped on purpose: unescaped, Markdown re-parses
 * `${_a}` … `${b_}` as emphasis and eats the underscores, so the escape is the
 * only representation that survives a round trip through the editor.
 */
export function unescapePromptVariables(body: string): string {
  return body.replaceAll(ESCAPED_TOKEN_RE, (match, raw: string) => {
    if (!raw.includes('\\')) return match
    const name = promptVariableName(raw)
    if (name == null) return match
    if (name.startsWith('_') || name.endsWith('_')) return match
    return `\${${name}}`
  })
}

/** Distinct `${token}` variable names referenced in a prompt body, in order. */
export function inferPromptVariables(body: string): string[] {
  const seen = new Set<string>()
  for (const m of body.matchAll(PROMPT_VARIABLE_RE)) {
    const name = promptVariableName(m[1])
    if (name != null) seen.add(name)
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
  return body.replaceAll(PROMPT_VARIABLE_RE, (match, raw: string) => {
    const key = promptVariableName(raw)
    return (key == null ? undefined : vars[key]) ?? match
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
  return template.replaceAll(PROMPT_VARIABLE_RE, (_match, raw: string) => {
    const key = promptVariableName(raw)
    const v = key == null ? null : bag[key]
    if (v == null) return ''
    if (typeof v === 'string') return v
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    return JSON.stringify(v)
  })
}
