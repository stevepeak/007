import { AlertTriangle, ChevronDown, Info, Sparkles } from 'lucide-react'
import { useCallback, useRef, useState, type ReactNode } from 'react'

import type {
  GraphIssue,
  JsonSchema,
  WorkflowGraph,
  WorkflowNode,
} from '../../engine'
import { cn } from '../cn'
import { AccessibleDataView } from './node-data-panel'

// A DevTools-style dock pinned to the bottom of an editor/detail surface. A tab
// strip is always visible; clicking the active tab (or the chevron) collapses
// the body. The chrome (resize handle + collapse + tab strip) lives in the
// generic `BottomTray`; the workflow editor's `BottomDock` (Data/Issues) is a
// thin composition of it. (The Chat assistant now lives in the persistent
// right-rail `CopilotPanel`, not here.)

// A lucide icon component, e.g. `Sparkles`.
type TrayIcon = typeof Sparkles

export type TrayTab = {
  id: string
  label: string
  icon?: TrayIcon
  /** Count badge after the label (e.g. issue count). */
  badge?: number
  /** Render the badge in the error (rose) palette instead of warning (amber). */
  danger?: boolean
  /** Right-aligned strip accessory, shown only while this tab is active + open. */
  accessory?: ReactNode
  /** Body content, rendered only while this tab is active + open. */
  body: ReactNode
}

// Body height bounds (px). At/below MIN a downward drag collapses the dock so
// only the tab strip shows; MAX keeps it from swallowing the whole surface.
const MIN_BODY_H = 120
const MAX_BODY_H = 640
const DEFAULT_BODY_H = 224

// The reusable tray chrome: a resizable, collapsible bottom panel with a tab
// strip. Owns open/active-tab/height state; the caller supplies the tabs.
function BottomTray({
  tabs,
  initialOpen = true,
}: {
  tabs: TrayTab[]
  /** Whether the body starts expanded. The tab strip always shows. */
  initialOpen?: boolean
}) {
  const [open, setOpen] = useState(initialOpen)
  const [activeId, setActiveId] = useState<string>(tabs[0]?.id ?? '')
  // Persisted body height; restored when the dock is re-opened via a tab/chevron.
  const [bodyHeight, setBodyHeight] = useState(DEFAULT_BODY_H)
  const dragRef = useRef<{
    startY: number
    startH: number
    moved: boolean
  } | null>(null)

  // Drag the top edge to resize: up grows the body, down shrinks it. Dragging
  // below MIN_BODY_H collapses to a tabs-only strip (open=false) while keeping
  // the last real height for when it's expanded again.
  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      dragRef.current = {
        startY: e.clientY,
        startH: open ? bodyHeight : 0,
        moved: false,
      }
    },
    [open, bodyHeight],
  )

  const onHandlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag) return
      // Ignore sub-pixel jitter so a plain click isn't treated as a drag.
      if (Math.abs(e.clientY - drag.startY) > 3) drag.moved = true
      if (!drag.moved) return
      const next = drag.startH + (drag.startY - e.clientY)
      if (next < MIN_BODY_H) {
        setOpen(false)
      } else {
        setOpen(true)
        setBodyHeight(Math.min(next, MAX_BODY_H))
      }
    },
    [],
  )

  const onHandlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      dragRef.current = null
      e.currentTarget.releasePointerCapture(e.pointerId)
      // A click on the border (no drag) toggles the dock collapsed/expanded.
      if (drag && !drag.moved) setOpen((o) => !o)
    },
    [],
  )

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]

  return (
    <div className="relative flex shrink-0 flex-col border-t border-border bg-card">
      {/* Grab bar straddling the top edge — drag to resize (^v cursor). */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize panel"
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        className="absolute inset-x-0 -top-1 z-10 h-2 cursor-ns-resize"
      />
      <div className="flex items-center gap-1 px-2">
        {tabs.map((t) => {
          const isActive = t.id === active?.id
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                // Clicking the active tab toggles the body, like DevTools.
                if (isActive) setOpen((o) => !o)
                else {
                  setActiveId(t.id)
                  setOpen(true)
                }
              }}
              className={cn(
                'flex items-center gap-1.5 border-b-2 px-2 py-1.5 text-xs font-medium transition-colors',
                isActive && open
                  ? 'border-neutral-800 text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {t.icon ? <t.icon className="size-3.5 text-violet-500" /> : null}
              {t.label}
              {t.badge ? (
                <span
                  className={cn(
                    'rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                    t.danger
                      ? 'bg-rose-100 text-rose-700'
                      : 'bg-amber-100 text-amber-700',
                  )}
                >
                  {t.badge}
                </span>
              ) : null}
            </button>
          )
        })}
        <div className="flex-1" />
        {open && active?.accessory ? active.accessory : null}
        <button
          type="button"
          aria-label={open ? 'Collapse panel' : 'Expand panel'}
          onClick={() => setOpen((o) => !o)}
          className="ml-1 rounded p-1 text-muted-foreground hover:bg-accent hover:text-muted-foreground"
        >
          <ChevronDown
            className={cn('size-4 transition-transform', !open && 'rotate-180')}
          />
        </button>
      </div>

      {open ? (
        <div
          style={{ height: bodyHeight }}
          className="overflow-y-auto border-t border-neutral-100 p-3"
        >
          {active?.body}
        </div>
      ) : null}
    </div>
  )
}

export type BottomDockProps = {
  /** The selected node, or null when nothing is selected. */
  node: WorkflowNode | null
  graph: WorkflowGraph
  /** All author-time issues for the graph (errors + warnings). */
  issues: GraphIssue[]
  /** Element schema of the enclosing loop's list, when the selected node is
   * inside an iteration — so the Data tab shows the `Item`'s fields. */
  itemSchema?: JsonSchema
  /** Focus a node on the canvas (clicking an issue that names one). */
  onSelectNode?: (nodeId: string) => void
}

// The workflow editor's dock: Data (selected node) and Issues (graph-wide). The
// Chat assistant now lives in the persistent right-rail `CopilotPanel`.
export function BottomDock({
  node,
  graph,
  issues,
  itemSchema,
  onSelectNode,
}: BottomDockProps) {
  const errorCount = issues.filter((i) => i.severity === 'error').length
  const warningCount = issues.length - errorCount

  const tabs: TrayTab[] = [
    {
      id: 'data',
      label: 'Data',
      accessory: node ? (
        <span className="truncate text-[11px] text-muted-foreground">
          {node.label}
        </span>
      ) : undefined,
      body: !node ? (
        <p className="text-muted-foreground text-xs">
          Select a node to see the data available to it.
        </p>
      ) : (
        <AccessibleDataView node={node} graph={graph} itemSchema={itemSchema} />
      ),
    },
    {
      id: 'issues',
      label: 'Issues',
      badge: issues.length || undefined,
      danger: errorCount > 0,
      body: (
        <IssuesView
          issues={issues}
          errorCount={errorCount}
          warningCount={warningCount}
          onSelectNode={onSelectNode}
        />
      ),
    },
  ]

  return <BottomTray tabs={tabs} />
}

function IssuesView({
  issues,
  errorCount,
  warningCount,
  onSelectNode,
}: {
  issues: GraphIssue[]
  errorCount: number
  warningCount: number
  onSelectNode?: (nodeId: string) => void
}) {
  if (issues.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        No issues — every node is configured and connected.
      </p>
    )
  }
  return (
    <div className="space-y-2">
      <div className="text-muted-foreground text-[11px]">
        {errorCount > 0
          ? `${errorCount} ${errorCount === 1 ? 'error' : 'errors'}`
          : null}
        {errorCount > 0 && warningCount > 0 ? ' · ' : null}
        {warningCount > 0
          ? `${warningCount} ${warningCount === 1 ? 'warning' : 'warnings'}`
          : null}
      </div>
      <ul className="space-y-1">
        {issues.map((issue, i) => (
          <IssueRow
            key={`${issue.nodeId ?? 'graph'}-${i}`}
            issue={issue}
            onSelectNode={onSelectNode}
          />
        ))}
      </ul>
    </div>
  )
}

function IssueRow({
  issue,
  onSelectNode,
}: {
  issue: GraphIssue
  onSelectNode?: (nodeId: string) => void
}) {
  const isError = issue.severity === 'error'
  const clickable = Boolean(issue.nodeId && onSelectNode)
  const Tag = clickable ? 'button' : 'div'
  return (
    <li>
      <Tag
        {...(clickable
          ? {
              type: 'button' as const,
              onClick: () => onSelectNode?.(issue.nodeId!),
            }
          : {})}
        className={cn(
          'flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left',
          isError
            ? 'border-rose-200 bg-rose-50/60'
            : 'border-amber-200 bg-amber-50/60',
          clickable && 'hover:bg-white',
        )}
      >
        {isError ? (
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-rose-500" />
        ) : (
          <Info className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
        )}
        <span className="min-w-0 flex-1 text-xs">
          {issue.nodeLabel ? (
            <span className="font-medium text-foreground">
              {issue.nodeLabel}:{' '}
            </span>
          ) : null}
          <span className="text-muted-foreground">{issue.message}</span>
        </span>
      </Tag>
    </li>
  )
}
