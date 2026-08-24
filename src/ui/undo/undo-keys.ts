// The two pure decisions behind app-wide undo: what a keystroke MEANS, and who
// OWNS it. Both are here rather than in the provider because they are the parts
// worth testing, and because "who owns Cmd+Z on this element" is a policy the
// rest of the SDK has to be able to read without importing React.

/** What a keydown is asking for, or `null` when it isn't asking for anything. */
export type UndoIntent = 'undo' | 'redo' | null

/**
 * Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z = redo, Ctrl+Y = redo (the Windows
 * spelling). Alt is excluded: Ctrl+Alt+Z is a distinct chord on several
 * keyboard layouts and is not ours to take.
 */
export function undoIntent(e: {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}): UndoIntent {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null
  const key = e.key.toLowerCase()
  if (key === 'z') return e.shiftKey ? 'redo' : 'undo'
  if (key === 'y' && !e.shiftKey) return 'redo'
  return null
}

/** Who should handle undo for a given event target. */
export type UndoOwner = 'app' | 'native'

/** What a surface can declare about itself via `data-wf-undo`. */
export type UndoMarker = UndoOwner | null

// Surfaces opt in or out by marking themselves, and the NEAREST marker wins —
// so a `native` island (a rich-text editor) inside an `app` region keeps its own
// history, and an `app` field inside a `native` region hands undo back to us.
const MARKER_ATTR = 'data-wf-undo'
const MARKER_SELECTOR = '[data-wf-undo]'

/**
 * The ownership policy, as a plain decision over two facts. Split out from the
 * DOM walk below because this table is the part that is ours — `closest()` is
 * the browser's own semantics and has nothing to assert about.
 *
 * The unmarked default is the rule the workflow editor already shipped: a plain
 * text field keeps the browser's own undo, everything else (canvas, buttons,
 * body) belongs to the app. Markers exist for the two cases that rule gets
 * wrong — a surface with its OWN history that must win (`native`, e.g. TipTap),
 * and a field whose value lives in an app undo stack (`app`).
 */
export function resolveUndoOwner(input: {
  marker: UndoMarker
  editable: boolean
}): UndoOwner {
  if (input.marker) return input.marker
  return input.editable ? 'native' : 'app'
}

function isEditableElement(el: Element): boolean {
  const tag = el.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    (el as HTMLElement).isContentEditable === true
  )
}

function nearestMarker(el: Element): UndoMarker {
  const marked = el.closest(MARKER_SELECTOR)
  const value = marked?.getAttribute(MARKER_ATTR)
  return value === 'native' || value === 'app' ? value : null
}

/** Resolve undo ownership for a real event target. */
export function undoOwner(target: EventTarget | null): UndoOwner {
  const el = target instanceof Element ? target : null
  if (!el) return 'app'
  return resolveUndoOwner({
    marker: nearestMarker(el),
    editable: isEditableElement(el),
  })
}
