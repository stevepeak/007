// Pure string helpers for bounded, human-readable previews. Engine-level so
// every layer (ui, mcp, eval) shares one truncation convention.

/**
 * Shorten `text` to `max` characters.
 *
 * - `'ellipsis'` (default): the result fits within `max`, ending in one `…`;
 *   trailing whitespace before the `…` is dropped.
 * - `'count'`: keeps the first `max` characters and says how many were dropped
 *   (`… [truncated N chars]`, with `hint` appended inside the brackets), so a
 *   reader can tell a clipped payload from the end of the data.
 */
export function truncate(args: {
  text: string
  max: number
  suffix?: 'ellipsis' | 'count'
  hint?: string
}): string {
  const { text, max, suffix = 'ellipsis', hint } = args
  if (text.length <= max) return text
  if (suffix === 'count') {
    const note = hint ? ` — ${hint}` : ''
    return `${text.slice(0, max)}… [truncated ${text.length - max} chars${note}]`
  }
  return `${text.slice(0, max - 1).trimEnd()}…`
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Pull the most human-relevant text out of a routed input / response payload,
 * WITHOUT truncating. Handles chat triggers (`{messages: [...]}` — the last
 * message's first text part, else its string content), agent output (`{text}`),
 * plain strings, and falls back to a compact JSON glimpse for anything else.
 *
 * Kept separate from `firstLine` so a caller can collapse a raw string it chose
 * itself (e.g. a prompt variable) at its own width.
 */
export function previewText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (isPlainRecord(value)) {
    if (typeof value.text === 'string') return value.text
    const messages = value.messages
    if (Array.isArray(messages) && messages.length > 0) {
      const last = messages[messages.length - 1] as {
        content?: unknown
        parts?: Array<{ type?: string; text?: string }>
      }
      const part = last.parts?.find(
        (p) => p.type === 'text' && typeof p.text === 'string',
      )
      if (part?.text) return part.text
      if (typeof last.content === 'string') return last.content
    }
  }
  return JSON.stringify(value)
}

/** First non-empty, trimmed line of `text`, truncated to fit within `max` chars. */
export function firstLine(text: string, max = 100): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  return truncate({ text: line, max })
}

/** `previewText` extraction collapsed to a single truncated line. */
export function previewLine(value: unknown, max = 100): string {
  return firstLine(previewText(value), max)
}
