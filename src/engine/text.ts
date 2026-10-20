// Pure helpers that turn values into bounded, human-readable text. Engine-level
// so every layer (ui, mcp, eval) shares one convention.

import { isRecord } from './guards'

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
  if (isRecord(value)) {
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

/**
 * Best-effort text for a value whose shape isn't known statically: a string as
 * itself, an object as JSON (`indent` spaces, compact by default), any other
 * primitive via `String`. Never throws and never returns `undefined`.
 *
 * `String(v)` alone renders an object as the useless `"[object Object]"`, and
 * `JSON.stringify(v)` alone returns `undefined` for `undefined` and throws on a
 * cycle or a BigInt. `undefined` is `''`; `null` is `nullText` (default `''`;
 * pass `'null'` where the reader expects JSON). An unserialisable object falls
 * back to its `Object.prototype.toString` tag.
 */
export function toText(
  value: unknown,
  args: { indent?: number; nullText?: string } = {},
): string {
  if (value === undefined) return ''
  if (value === null) return args.nullText ?? ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, args.indent) ?? ''
    } catch {
      return Object.prototype.toString.call(value)
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- primitives only by here
  return String(value)
}

/**
 * A short elapsed span for engine-written progress copy: `820ms` below a
 * second, then seconds with one decimal (`3.4s`, `75.0s`). Coarser than the
 * UI's `formatDurationMs`, which rolls over into whole seconds and minutes.
 */
export function formatElapsedMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}
