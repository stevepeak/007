import { ChevronDown } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'

import type { WorkflowNode } from '../engine'
import type { WfRunStepDTO } from '../server/protocol'
import { useWfComponents } from './context'
import { cn } from './cn'
import { RunLog } from './run-log'

// The run viewer's bottom dock (DevTools-style, like the editor's Data/Issues
// dock): it focuses on ONE node — whichever is selected on the run graph — and
// shows that step's logs as an AI-style timeline (Input → thinking → tool call →
// … → Output). The graph itself is the node list, so there's no list here.
// Collapsible via the "Logs" label, the chevron, or a click on the top border.

const statusBadge: Record<string, string> = {
  completed: 'bg-green-100 text-green-700 border-green-200',
  running: 'bg-blue-100 text-blue-700 border-blue-200',
  failed: 'bg-red-100 text-red-700 border-red-200',
  skipped: 'bg-neutral-100 text-neutral-500 border-neutral-200',
  queued: 'bg-amber-100 text-amber-700 border-amber-200',
}

export type RunNodeDockProps = {
  /** The node selected on the run graph, or null when nothing is selected. */
  node: WorkflowNode | null
  /** The recorded step for that node, or null if it never executed (skipped). */
  step: WfRunStepDTO | null
}

// Height bounds for the resizable body: never let it shrink out of sight, and
// keep the graph above it usable at the top.
const MIN_DOCK_H = 120
const DEFAULT_DOCK_H = 224
function maxDockH(): number {
  return typeof window !== 'undefined'
    ? Math.max(MIN_DOCK_H, window.innerHeight - 160)
    : 640
}

export function RunNodeDock({ node, step }: RunNodeDockProps) {
  const { Badge } = useWfComponents()
  const [open, setOpen] = useState(true)

  // Drag-to-resize the body height. The top border doubles as the handle: a
  // click (no movement) toggles the panel, a drag resizes it (clamped so it
  // stays visible). `open` is mirrored into a ref so the move handler can read
  // it without re-subscribing.
  const [height, setHeight] = useState(DEFAULT_DOCK_H)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ startY: number; startH: number; moved: boolean } | null>(
    null,
  )
  const openRef = useRef(open)
  openRef.current = open

  const onDrag = useCallback((e: MouseEvent) => {
    const d = dragRef.current
    if (!d) return
    const delta = d.startY - e.clientY // drag up → taller
    if (Math.abs(delta) > 3) d.moved = true
    setHeight(Math.min(maxDockH(), Math.max(MIN_DOCK_H, d.startH + delta)))
    if (!openRef.current) setOpen(true)
  }, [])

  const endDrag = useCallback(() => {
    const d = dragRef.current
    document.removeEventListener('mousemove', onDrag)
    document.removeEventListener('mouseup', endDrag)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    setDragging(false)
    // A click with no meaningful drag toggles the panel, like the chevron.
    if (d && !d.moved) setOpen((o) => !o)
    dragRef.current = null
  }, [onDrag])

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragRef.current = { startY: e.clientY, startH: height, moved: false }
      setDragging(true)
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'ns-resize'
      document.addEventListener('mousemove', onDrag)
      document.addEventListener('mouseup', endDrag)
    },
    [height, onDrag, endDrag],
  )

  return (
    <div className="flex shrink-0 flex-col border-t border-neutral-200 bg-white">
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize panel — drag to resize, click to hide"
        onMouseDown={startDrag}
        className={cn(
          '-mt-px h-1.5 w-full shrink-0 cursor-ns-resize transition-colors',
          dragging ? 'bg-neutral-300' : 'hover:bg-neutral-200/70',
        )}
      />
      <div className="flex items-center gap-1 px-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            'border-b-2 px-2 py-1.5 text-xs font-medium transition-colors',
            open
              ? 'border-neutral-800 text-neutral-800'
              : 'border-transparent text-neutral-500 hover:text-neutral-700',
          )}
        >
          Logs
        </button>
        <div className="flex-1" />
        {node ? (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[11px] text-neutral-400">
              {node.label}
            </span>
            {step ? (
              <Badge className={cn('border', statusBadge[step.status])}>
                {step.status}
              </Badge>
            ) : (
              <span className="text-[11px] text-neutral-400">not run</span>
            )}
          </span>
        ) : null}
        <button
          type="button"
          aria-label={open ? 'Collapse panel' : 'Expand panel'}
          onClick={() => setOpen((o) => !o)}
          className="ml-1 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
        >
          <ChevronDown
            className={cn('size-4 transition-transform', !open && 'rotate-180')}
          />
        </button>
      </div>

      {open ? (
        <div
          style={{ height }}
          className="overflow-y-auto border-t border-neutral-100 p-3"
        >
          {!node ? (
            <p className="text-xs text-neutral-500">
              Select a node on the graph to inspect its run.
            </p>
          ) : !step ? (
            <p className="text-xs text-neutral-500">
              This node didn&apos;t run — the branch it&apos;s on wasn&apos;t
              taken, or the run stopped before reaching it.
            </p>
          ) : (
            <RunLog step={step} />
          )}
        </div>
      ) : null}
    </div>
  )
}
