// Best-effort one-line previews of message/response payloads, shared by the run
// log and the "create sample from run" flow (both used to carry their own copy).
// Pure string logic — no React, no server deps.
//
// The extraction (`previewText`) and the collapse-to-one-line (`firstLine`) are
// kept separate so callers can compose them differently: the run log wants the
// combined `previewLine`, while `deriveTitle` collapses its own already-chosen
// raw string (which may be a prompt variable, not the input) at a shorter width.

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Pull the most human-relevant text out of a routed input / response payload,
 * WITHOUT truncating. Handles chat triggers (`{messages: [...]}` — the last
 * message's first text part, else its string content), agent output (`{text}`),
 * plain strings, and falls back to a compact JSON glimpse for anything else.
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

/** First non-empty, trimmed line of `text`, truncated to `max` chars with an ellipsis. */
export function firstLine(text: string, max = 100): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/** `previewText` extraction collapsed to a single truncated line. */
export function previewLine(value: unknown, max = 100): string {
  return firstLine(previewText(value), max)
}
