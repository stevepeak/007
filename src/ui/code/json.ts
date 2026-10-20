import { errorMessage } from '../../engine/error-message'
// Parsing and formatting for the JSON an author types by hand — the half of a
// JSON field that isn't rendering. Kept apart from `CodeEditor` so the rules are
// testable without a DOM.

export type JsonParse =
  | { ok: true; value: unknown }
  | { ok: false; error: string }

/**
 * Parse with an error an author can act on.
 *
 * `JSON.parse`'s message names a character offset, which is useless against a
 * ten-line box; this reports the line and column instead.
 */
export function parseJson(text: string): JsonParse {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (err) {
    return { ok: false, error: describeJsonError(err, text) }
  }
}

function describeJsonError(err: unknown, text: string): string {
  const raw = errorMessage(err)
  const at = /position (\d+)/i.exec(raw)
  // Each engine phrases (and decorates) this differently: V8 appends the byte
  // offset, JSC and SpiderMonkey prefix the thrower's name, SpiderMonkey also
  // trails "of the JSON data". Strip the decoration; keep the diagnosis.
  const message = raw
    .replace(/^(?:JSON\.parse: |JSON Parse error: )/, '')
    .replace(/\s*(?:in JSON )?at position \d.*$/i, '')
    .replace(/\s+of the JSON data\.?$/i, '')
    .trim()
  if (!at) return message
  const pos = Math.min(Number(at[1]), text.length)
  const before = text.slice(0, pos)
  const line = before.split('\n').length
  const column = pos - before.lastIndexOf('\n')
  return `${message} (line ${line}, column ${column})`
}

/** Pretty-print `text` at 2-space indent, or `null` if it doesn't parse. */
export function formatJson(text: string): string | null {
  const parsed = parseJson(text)
  if (!parsed.ok) return null
  try {
    return JSON.stringify(parsed.value, null, 2)
  } catch {
    return null
  }
}

/**
 * Text an author typed, as a value: JSON when it parses, else the raw text, so
 * a mid-edit document or deliberate plain text is kept rather than dropped.
 *
 * - `structuredOnly`: only text starting with `{` or `[` is parsed, so a typed
 *   `42` or `true` stays the string it is.
 * - `empty`: what blank text yields — the raw text itself (default), `''`, or
 *   `undefined`.
 */
export function parseLooseJson(args: {
  text: string
  structuredOnly?: boolean
  empty?: 'text' | 'string' | 'undefined'
}): unknown {
  const { text, structuredOnly = false, empty = 'text' } = args
  const trimmed = text.trim()
  if (!trimmed) {
    if (empty === 'string') return ''
    if (empty === 'undefined') return undefined
    return text
  }
  if (structuredOnly && !trimmed.startsWith('{') && !trimmed.startsWith('['))
    return text
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return text
  }
}
