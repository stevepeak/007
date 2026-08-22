import { useCallback, useRef, useState } from 'react'

// A bottom dock whose top border is both the resize handle and the show/hide
// toggle: drag it to resize, click it to fold the panel away.
//
// The two gestures share one mousedown, so they are told apart at mouseUP by
// whether the pointer actually moved — a few pixels of slop, since a click on a
// 6px-tall strip is rarely perfectly still.

/** Never let the dock shrink out of sight. */
const MIN_DOCK_H = 120
const DEFAULT_DOCK_H = 224
/** …and keep the content above it usable at the top. */
function maxDockH(): number {
  return typeof window !== 'undefined'
    ? Math.max(MIN_DOCK_H, window.innerHeight - 160)
    : 640
}

export function useResizableDock(initialHeight: number = DEFAULT_DOCK_H) {
  const [open, setOpen] = useState(true)
  const [height, setHeight] = useState(initialHeight)
  const [dragging, setDragging] = useState(false)

  // `abort` cancels both document listeners at once. They used to be removed by
  // name, which meant `endDrag` had to reference itself inside its own
  // definition — a read-before-declaration React's compiler rejects, and a live
  // hazard besides: a listener removed by a stale function identity is a
  // listener that stays attached.
  const dragRef = useRef<{
    startY: number
    startH: number
    moved: boolean
    abort: AbortController
  } | null>(null)
  // Mirrored into a ref so the move handler can read `open` without
  // re-subscribing on every toggle.
  const openRef = useRef(open)
  openRef.current = open

  const onDrag = useCallback((e: MouseEvent) => {
    const d = dragRef.current
    if (!d) return
    const delta = d.startY - e.clientY // drag up → taller
    if (Math.abs(delta) > 3) d.moved = true
    setHeight(Math.min(maxDockH(), Math.max(MIN_DOCK_H, d.startH + delta)))
    // Dragging a closed dock open is the obvious intent.
    if (!openRef.current) setOpen(true)
  }, [])

  const endDrag = useCallback(() => {
    const d = dragRef.current
    d?.abort.abort()
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    setDragging(false)
    // A click with no meaningful drag toggles the panel, like the chevron.
    if (d && !d.moved) setOpen((o) => !o)
    dragRef.current = null
  }, [])

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const abort = new AbortController()
      dragRef.current = { startY: e.clientY, startH: height, moved: false, abort }
      setDragging(true)
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'ns-resize'
      const { signal } = abort
      document.addEventListener('mousemove', onDrag, { signal })
      document.addEventListener('mouseup', endDrag, { signal })
    },
    [height, onDrag, endDrag],
  )

  return { open, setOpen, height, dragging, startDrag }
}
