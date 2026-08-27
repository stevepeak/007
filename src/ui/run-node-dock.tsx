import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  SquareArrowOutUpRight,
} from 'lucide-react'
import { useState } from 'react'

import type { WorkflowGraph, WorkflowNode } from '../engine'
import type {
  WfRunLogDTO,
  WfRunStepDTO,
  WfRunSummary,
} from '../server/protocol'

import { cn } from './cn'
import { useWfComponents } from './context'
import { CreateSampleFromRun } from './evals/create-sample-from-run'
import { WfLink } from './nav'
import { RunActivityLog } from './run-activity-log'
import { stepAgentVersion } from './run-agent-versions'
import { RunLog } from './run-log'
import { runStatusClass } from './run-status'
import { useResizableDock } from './use-resizable-dock'

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
  /** The runs this run spawned — durable iteration items and callees. Their
   *  work happened on their own runs, so the Activity tree links out to them
   *  rather than showing per-item rows it has no steps for. */
  childRuns?: WfRunSummary[]
  /** The log feed was capped server-side — passed through to the activity feed. */
  logsTruncated?: boolean
  /** The run's graph at the version that ran — the Activity tree's skeleton. */
  graph: WorkflowGraph | null
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
  /** The focused item's name, shown on hover — the stepper stays numeric so it
   *  keeps its fixed width as you page through items. */
  itemTitle?: string | null
  onSelectItem?: (index: number) => void
  /** Which tab the dock opens on. Defaults to the run-wide Activity feed; a
   *  deep link that already names a node opens on that node's trace instead. */
  initialTab?: 'activity' | 'logs'
}

export function RunNodeDock({
  node,
  step,
  steps,
  logs,
  childRuns,
  logsTruncated,
  graph,
  live,
  selectedNodeId,
  onSelectNode,
  itemIndex,
  itemCount = 0,
  itemTitle,
  onSelectItem,
  initialTab = 'activity',
}: RunNodeDockProps) {
  const { Badge } = useWfComponents()
  const hasItemPicker = itemCount > 0 && itemIndex != null
  const { open, setOpen, height, dragging, startDrag } = useResizableDock()
  const [tab, setTab] = useState<'activity' | 'logs'>(initialTab)

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
                  disabled={itemIndex <= 0}
                  onClick={() => onSelectItem?.(itemIndex - 1)}
                  className="rounded p-0.5 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700 disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <ChevronLeft className="size-3.5" />
                </button>
                <span
                  className="px-1 text-[11px] font-medium text-neutral-600 tabular-nums"
                  title={itemTitle ?? undefined}
                >
                  item {itemIndex + 1}/{itemCount}
                </span>
                <button
                  type="button"
                  aria-label="Next item"
                  disabled={itemIndex >= itemCount - 1}
                  onClick={() => onSelectItem?.(itemIndex + 1)}
                  className="rounded p-0.5 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700 disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <ChevronRight className="size-3.5" />
                </button>
              </span>
            ) : null}
            <NodeLabel node={node} step={step} />
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
              logsTruncated={logsTruncated}
              steps={steps}
              childRuns={childRuns}
              graph={graph}
              live={live}
              selectedNodeId={selectedNodeId}
              selectedItemIndex={itemIndex}
              onSelectNode={onSelectNode}
              onSelectItem={onSelectItem}
              // Double-click a row: select its node on the graph AND flip to the
              // Inspect view focused on it.
              onInspectNode={(nodeId) => {
                onSelectNode?.(nodeId)
                setTab('logs')
              }}
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

// The dock's node title. An agent node inspected here is a pointer at a reusable
// agent, so its title doubles as the jump back to that agent — every other kind
// renders as plain text. Opens the agent editor in a NEW tab on purpose: you're
// mid-investigation on a run and shouldn't lose it to a plain navigation. The
// version is the one the run FROZE (stamped on the step by the run manifest),
// falling back to the node's pin, so the link names what actually executed.
function NodeLabel({
  node,
  step,
}: {
  node: WorkflowNode
  step: WfRunStepDTO | null
}) {
  const plain = (
    <span className="truncate text-[11px] text-neutral-400">{node.label}</span>
  )
  if (node.kind !== 'agent') return plain
  const agentId = node.config.agentId
  if (!agentId) return plain
  // Prefer what the run froze; fall back to the node's own pin (null = it
  // floated, and an unrun step can't tell us where it would have landed).
  const version = stepAgentVersion(step) ?? node.config.version
  return (
    <WfLink
      to={`agents/${agentId}/edit`}
      newTab
      className="inline-flex min-w-0 items-center gap-1 text-[11px] text-neutral-500 hover:text-neutral-800 hover:underline"
      title="Open this agent in a new tab"
    >
      <span className="truncate">{node.label}</span>
      {version != null ? (
        <span className="shrink-0 text-neutral-400 tabular-nums">
          v{version}
        </span>
      ) : null}
      <SquareArrowOutUpRight className="size-3 shrink-0" />
    </WfLink>
  )
}
