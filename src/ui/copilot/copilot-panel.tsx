'use client'

import { ChevronRight, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { cn } from '../cn'
import { useWfAssistant, type WfAssistantContext } from '../context'
import { CopilotAssistant } from './copilot-assistant'

// The persistent right-rail Copilot. Mounted ONCE at the workflow app shell (see
// `wf-app.tsx`), so it — and the single continuous conversation inside it —
// survive all in-app navigation (tab/section/asset switches never remount it).
// The `context` prop is the currently-focused view (derived from the active tab
// by `deriveCopilotContext`); it changes as the user navigates and rides on each
// request, but the thread itself keeps going.
//
// Collapsing does NOT unmount the assistant — the expanded body is kept mounted
// and merely hidden (the same keep-alive trick the tab shell uses), so the
// conversation is never dropped by toggling the rail.
//
// A host MAY inject its own assistant via `WfSdkProvider assistant={…}` to
// replace the built-in System Copilot entirely; that override wins when present.

// Width bounds (px) for the resizable rail.
const MIN_WIDTH = 280
const MAX_WIDTH = 640
const DEFAULT_WIDTH = 380

const OPEN_STORAGE_KEY = 'wf-copilot-panel-open'
const WIDTH_STORAGE_KEY = 'wf-copilot-panel-width'

function readStoredOpen(): boolean {
  if (typeof window === 'undefined') return false
  // Default closed on first load so the rail doesn't crowd the editor until the
  // user reaches for it.
  return window.localStorage.getItem(OPEN_STORAGE_KEY) === '1'
}

function readStoredWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_WIDTH
  const raw = Number(window.localStorage.getItem(WIDTH_STORAGE_KEY))
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_WIDTH
  return Math.min(Math.max(raw, MIN_WIDTH), MAX_WIDTH)
}

export function CopilotPanel({ context }: { context: WfAssistantContext }) {
  const Assistant = useWfAssistant() ?? CopilotAssistant
  const [open, setOpen] = useState(readStoredOpen)
  const [width, setWidth] = useState(readStoredWidth)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(OPEN_STORAGE_KEY, open ? '1' : '0')
  }, [open])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(width))
  }, [width])

  // Drag the left edge to resize: leftward grows the rail, rightward shrinks it.
  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      dragRef.current = { startX: e.clientX, startW: width }
    },
    [width],
  )
  const onHandlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag) return
      const next = drag.startW + (drag.startX - e.clientX)
      setWidth(Math.min(Math.max(next, MIN_WIDTH), MAX_WIDTH))
    },
    [],
  )
  const onHandlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      dragRef.current = null
      e.currentTarget.releasePointerCapture(e.pointerId)
    },
    [],
  )

  return (
    <div className="flex h-full shrink-0">
      {/* Collapsed strip — a thin reopen affordance, shown only when closed. */}
      {!open ? (
        <div className="flex h-full flex-col items-center border-l border-border bg-card">
          <button
            type="button"
            aria-label="Open Copilot"
            title="Open Copilot"
            onClick={() => setOpen(true)}
            className="mt-2 flex flex-col items-center gap-2 rounded p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Sparkles className="size-4 text-violet-500" />
            <span className="text-[11px] font-medium tracking-wide [writing-mode:vertical-rl]">
              Copilot
            </span>
          </button>
        </div>
      ) : null}

      {/* Expanded panel — ALWAYS mounted (hidden when collapsed) so the
          conversation state is never dropped by toggling the rail. */}
      <div
        style={{ width }}
        className={cn(
          'relative flex h-full flex-col border-l border-border bg-card',
          !open && 'hidden',
        )}
      >
        {/* Grab bar straddling the left edge — drag to resize (<> cursor). */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize Copilot"
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          className="absolute inset-y-0 -left-1 z-10 w-2 cursor-ew-resize"
        />

        <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
          <Sparkles className="size-4 text-violet-500" />
          <span className="text-sm font-medium text-foreground">Copilot</span>
          <div className="flex-1" />
          <button
            type="button"
            aria-label="Collapse Copilot"
            title="Collapse Copilot"
            onClick={() => setOpen(false)}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 p-2">
          <Assistant
            subject={context.subject}
            subjectId={context.subjectId}
            runId={context.runId}
          />
        </div>
      </div>
    </div>
  )
}
