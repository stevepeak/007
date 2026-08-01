import { type ReactNode, useRef, useState } from 'react'

import { useDismiss } from './use-dismiss'

// The headless popover shell. Every custom picker (model, tool, target filter,
// the copilot's model menu) hand-rolled the same open-state + ref +
// outside-dismiss + conditionally-rendered panel skeleton — and one that forgot
// it (an editor menu) silently lost outside-click dismissal. This owns that
// skeleton once; callers supply their exact trigger, panel classes, and rows, so
// nothing about their look or layout changes. `RichSelect` (the flat single-
// select) is built on this too.
//
// Positioning is deliberately NOT baked in: the panel className is passed
// verbatim by the caller (absolute vs inline, up vs down, width), because those
// genuinely differ per site. This component only owns state + dismissal + the
// open/closed toggle of the panel div.

export type PopoverApi = {
  open: boolean
  /** Flip the panel open/closed (the trigger's onClick). */
  toggle: () => void
  /** Close the panel (call after a selection). */
  close: () => void
}

export function Popover({
  className,
  panelClassName,
  trigger,
  children,
}: {
  /** Class for the relative/flow container that owns the outside-click ref. */
  className?: string
  /** The full panel class — position (absolute/inline), width, palette, etc. */
  panelClassName?: string
  /** The always-visible trigger (and any siblings shown next to it). */
  trigger: (api: PopoverApi) => ReactNode
  /** The panel body, rendered only while open. */
  children: (api: PopoverApi) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, open, () => setOpen(false))
  const api: PopoverApi = {
    open,
    toggle: () => setOpen((o) => !o),
    close: () => setOpen(false),
  }
  return (
    <div ref={ref} className={className}>
      {trigger(api)}
      {open ? <div className={panelClassName}>{children(api)}</div> : null}
    </div>
  )
}
