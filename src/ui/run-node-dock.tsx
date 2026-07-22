import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'

import type { WorkflowNode } from '../engine'
import type { WfRunLogDTO, WfRunStepDTO } from '../server/protocol'
import { useWfComponents } from './context'
import { cn } from './cn'
import { CreateSampleFromRun } from './evals/create-sample-from-run'
import { RunActivityLog } from './run-activity-log'
import { RunLog } from './run-log'
import { runStatusClass } from './run-status'

// The run viewer's bottom dock (DevTools-style, like the editor's Data/Issues
// dock). Two tabs:
//   • Activity — the whole run's chronological progress feed (what step it's on,
//     the AI's internal thinking, tool calls), streaming while the run is live.
//   • Logs — the ONE selected node's machine trace as an AI-style timeline
//     (Input → thinking → tool call → … → Output).
// The graph itself is the node list, so there's no list here. Collapsible via a
// tab, the chevron, or a click on the top border.

export type RunNodeDockProps = {
  /** The node selected on the run graph, or null when nothing is selected. */
  node: WorkflowNode | null
  /** The recorded step for that node, or null if it never executed (skipped). */
  step: WfRunStepDTO | null
  /** Every recorded step in the run — lets the "Create Sample" action rebuild an
   *  agent node's Given by resolving its ref inputs against recorded outputs. */
  steps: WfRunStepDTO[]
  /** The whole run's structured progress feed (drives the Activity tab). */
  logs: WfRunLogDTO[]
  /** True while the run is still executing — enables the live/auto-scroll UI. */
  live?: boolean
  /** The selected node's id, for highlighting its rows in the Activity feed. */
  selectedNodeId?: string | null
  /** Select a node on the graph (from clicking an Activity row). */
  onSelectNode?: (nodeId: string) => void
  /**
   * Iteration per-item picker. When the selected node lives inside an iteration,
   * `itemIndex` is the 0-based item currently shown and `itemCount` the total —
   * the header renders a `‹ item k / N ›` stepper wired to `onSelectItem`. Null
   * / 0 outside an iteration, where the stepper is hidden.
   */
  itemIndex?: number | null
  itemCount?: number
  onSelectItem?: (index: number) => void
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

export function RunNodeDock({
  node,
  step,
  steps,
  logs,
  live,
  selectedNodeId,
  onSelectNode,
  itemIndex,
  itemCount = 0,
  onSelectItem,
}: RunNodeDockProps) {
  const { Badge } = useWfComponents()
  const hasItemPicker = itemCount > 0 && itemIndex != null
  const [open, setOpen] = useState(true)
  const [tab, setTab] = useState<'activity' | 'logs'>('activity')

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
          onClick={() => {
            setTab('activity')
            setOpen(true)
          }}
          className={cn(
            'border-b-2 px-2 py-1.5 text-xs font-medium transition-colors',
            open && tab === 'activity'
              ? 'border-neutral-800 text-neutral-800'
              : 'border-transparent text-neutral-500 hover:text-neutral-700',
          )}
        >
          Activity
          {live ? (
            <span className="ml-1.5 inline-block size-1.5 animate-pulse rounded-full bg-blue-500 align-middle" />
          ) : null}
        </button>
        <button
          type="button"
          onClick={() => {
            setTab('logs')
            setOpen(true)
          }}
          className={cn(
            'border-b-2 px-2 py-1.5 text-xs font-medium transition-colors',
            open && tab === 'logs'
              ? 'border-neutral-800 text-neutral-800'
              : 'border-transparent text-neutral-500 hover:text-neutral-700',
          )}
        >
          Inspect
        </button>
        <div className="flex-1" />
        {tab === 'logs' && node ? (
          <span className="flex min-w-0 items-center gap-2">
            {hasItemPicker ? (
              <span className="flex shrink-0 items-center gap-0.5 rounded border border-neutral-200 bg-neutral-50 px-0.5 py-px">
                <button
                  type="button"
                  aria-label="Previous item"
                  disabled={itemIndex! <= 0}
                  onClick={() => onSelectItem?.(itemIndex! - 1)}
                  className="rounded p-0.5 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700 disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <ChevronLeft className="size-3.5" />
                </button>
                <span className="px-1 text-[11px] font-medium text-neutral-600 tabular-nums">
                  item {itemIndex! + 1}/{itemCount}
                </span>
                <button
                  type="button"
                  aria-label="Next item"
                  disabled={itemIndex! >= itemCount - 1}
                  onClick={() => onSelectItem?.(itemIndex! + 1)}
                  className="rounded p-0.5 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700 disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <ChevronRight className="size-3.5" />
                </button>
              </span>
            ) : null}
            <span className="truncate text-[11px] text-neutral-400">
              {node.label}
            </span>
            {step ? (
              <Badge className={cn('border', runStatusClass[step.status])}>
                {step.status}
              </Badge>
            ) : (
              <span className="text-[11px] text-neutral-400">
                {hasItemPicker ? 'no data for this item' : 'not run'}
              </span>
            )}
            <CreateSampleFromRun node={node} step={step} steps={steps} />
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
          {tab === 'activity' ? (
            <RunActivityLog
              logs={logs}
              live={live}
              selectedNodeId={selectedNodeId}
              onSelectNode={onSelectNode}
            />
          ) : !node ? (
            <p className="text-xs text-neutral-500">
              Select a node on the graph to inspect its run.
            </p>
          ) : !step ? (
            <p className="text-xs text-neutral-500">
              {hasItemPicker
                ? 'This node has no recorded step for the selected item — the item may have been skipped or stopped early. Try another item.'
                : "This node didn't run — the branch it's on wasn't taken, or the run stopped before reaching it."}
            </p>
          ) : (
            <RunLog step={step} />
          )}
        </div>
      ) : null}
    </div>
  )
}
