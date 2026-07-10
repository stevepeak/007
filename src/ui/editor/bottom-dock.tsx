import { AlertTriangle, ChevronDown, Info } from 'lucide-react'
import { useState } from 'react'

import type {
  GraphIssue,
  JsonSchema,
  WorkflowGraph,
  WorkflowNode,
} from '../../engine'
import { cn } from '../cn'
import { AccessibleDataView } from './node-data-panel'

// A DevTools-style dock pinned to the bottom of the editor. A tab strip is
// always visible; clicking the active tab (or the chevron) collapses the body.
// The Data tab reflects the selected node; the Issues tab is graph-wide.

type DockTab = 'data' | 'issues'

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

export function BottomDock({
  node,
  graph,
  issues,
  itemSchema,
  onSelectNode,
}: BottomDockProps) {
  const [open, setOpen] = useState(true)
  const [tab, setTab] = useState<DockTab>('data')

  const errorCount = issues.filter((i) => i.severity === 'error').length
  const warningCount = issues.length - errorCount

  const tabs: {
    id: DockTab
    label: string
    badge?: number
    danger?: boolean
  }[] = [
    { id: 'data', label: 'Data' },
    {
      id: 'issues',
      label: 'Issues',
      badge: issues.length || undefined,
      danger: errorCount > 0,
    },
  ]

  return (
    <div className="flex shrink-0 flex-col border-t border-neutral-200 bg-white">
      <div className="flex items-center gap-1 px-2">
        {tabs.map((t) => {
          const active = t.id === tab
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                // Clicking the active tab toggles the body, like DevTools.
                if (active) setOpen((o) => !o)
                else {
                  setTab(t.id)
                  setOpen(true)
                }
              }}
              className={cn(
                'flex items-center gap-1.5 border-b-2 px-2 py-1.5 text-xs font-medium transition-colors',
                active && open
                  ? 'border-neutral-800 text-neutral-800'
                  : 'border-transparent text-neutral-500 hover:text-neutral-700',
              )}
            >
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
        {tab === 'data' && node ? (
          <span className="truncate text-[11px] text-neutral-400">
            {node.label}
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
        <div className="h-56 overflow-y-auto border-t border-neutral-100 p-3">
          {tab === 'issues' ? (
            <IssuesView
              issues={issues}
              errorCount={errorCount}
              warningCount={warningCount}
              onSelectNode={onSelectNode}
            />
          ) : !node ? (
            <p className="text-muted-foreground text-xs">
              Select a node to see the data available to it.
            </p>
          ) : (
            <AccessibleDataView
              node={node}
              graph={graph}
              itemSchema={itemSchema}
            />
          )}
        </div>
      ) : null}
    </div>
  )
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
            <span className="font-medium text-neutral-700">
              {issue.nodeLabel}:{' '}
            </span>
          ) : null}
          <span className="text-neutral-600">{issue.message}</span>
        </span>
      </Tag>
    </li>
  )
}
