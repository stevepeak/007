// The one-line text of a thrown value. A leaf module — no imports — so the UI,
// the MCP layer and the engine can all reach it without pulling in the AI SDK.
//
// JS permits throwing anything, and the inline `err instanceof Error ?
// err.message : String(err)` turns a plain object (JSONata throws them) into
// "[object Object]". This keeps its `message` when it has one and serializes it
// otherwise.

/** The message of a thrown value, readable whatever was thrown. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  const message = (err as { message?: unknown } | null | undefined)?.message
  if (typeof message === 'string' && message) return message
  return stringifyThrown(err)
}

/** Readable text for a thrown value that isn't an Error. */
export function stringifyThrown(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null || typeof value !== 'object') return String(value)
  try {
    // A circular object throws here; a function or symbol returns undefined.
    return JSON.stringify(value) ?? Object.prototype.toString.call(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}
