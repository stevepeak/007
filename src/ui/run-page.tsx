import { Activity, ChevronDown, RotateCcw } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { WorkflowGraph, WorkflowNode } from '../engine'
import type { RetryRunMode } from '../server/protocol'
import { useWfComponents } from './context'
import { cn } from './cn'
import { WorkflowCanvas } from './editor/workflow-canvas'
import { useRetryRun, useRun } from './hooks'
import { useWfNav } from './nav'
import { RunNodeDock } from './run-node-dock'
import { WfShell } from './shell'

// Full-page run viewer. Clicking a row in the runs explorer lands here. The
// centerpiece is the workflow rendered read-only at the exact version that ran,
// with each node tinted by its run status (failed = red). Selecting a node opens
// its Input / Logs / Output in the bottom dock — the graph IS the node list, so
// there's no separate trace column. A failed run can be re-dispatched via Retry.

const statusClass: Record<string, string> = {
  completed: 'bg-green-100 text-green-700 border-green-200',
  running: 'bg-blue-100 text-blue-700 border-blue-200',
  failed: 'bg-red-100 text-red-700 border-red-200',
  queued: 'bg-amber-100 text-amber-700 border-amber-200',
  cancelled: 'bg-neutral-100 text-neutral-500 border-neutral-200',
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function fmtDuration(start: number, end: number | null): string {
  if (end == null) return '—'
  const secs = Math.max(0, Math.round((end - start) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ${secs % 60}s`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m`
}

// Human labels for a run's trigger kind, so the breadcrumb reads "Chat message"
// rather than the raw `chat` slug. Unknown kinds are title-cased as a fallback.
const TRIGGER_LABELS: Record<string, string> = {
  chat: 'Chat message',
  manual: 'Manual run',
  webhook: 'Webhook',
  schedule: 'Scheduled run',
  cron: 'Scheduled run',
  api: 'API request',
  eval: 'Eval run',
}

function triggerLabel(kind: string): string {
  return TRIGGER_LABELS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1)
}

// Coarse "N units ago" phrasing for the run's breadcrumb label.
function fmtRelative(ms: number): string {
  const sec = Math.round((Date.now() - ms) / 1000)
  if (sec < 60) return 'just now'
  const units: [number, string][] = [
    [60, 'minute'],
    [60, 'hour'],
    [24, 'day'],
    [30, 'month'],
    [12, 'year'],
  ]
  let value = sec
  let label = 'second'
  for (const [size, name] of units) {
    if (value < size) break
    value = Math.floor(value / size)
    label = name
  }
  return `${value} ${label}${value === 1 ? '' : 's'} ago`
}

// Find a node by id across the top level AND any iteration container's subgraph,
// so selecting an inner loop node still resolves (its steps aren't recorded
// individually, so the dock shows it as "not run", which is accurate).
function findNode(graph: WorkflowGraph, id: string): WorkflowNode | null {
  for (const n of graph.nodes) {
    if (n.id === id) return n
    if (n.kind === 'iteration') {
      const child = n.config.subgraph.nodes.find((c) => c.id === id)
      if (child) return child
    }
  }
  return null
}

export type RunPageProps = {
  runId: string
  className?: string
}

export function RunPage({ runId, className }: RunPageProps) {
  const { Badge } = useWfComponents()
  const { navigate } = useWfNav()
  const { data, isLoading, error } = useRun(runId)
  const retry = useRetryRun()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // nodeId → status, driving the canvas tint + status dots. Steps only cover
  // top-level nodes (iteration inner steps aren't recorded), which is exactly
  // the set the canvas renders as top-level nodes.
  const nodeStatuses = useMemo(
    () => new Map((data?.steps ?? []).map((s) => [s.nodeId, s.status])),
    [data?.steps],
  )

  if (isLoading) {
    return (
      <div className={cn('p-6 text-sm text-neutral-500', className)}>
        Loading run…
      </div>
    )
  }
  if (error) {
    return (
      <div className={cn('p-6 text-sm text-red-600', className)}>
        {(error as Error).message}
      </div>
    )
  }
  if (!data) {
    return (
      <div className={cn('p-6 text-sm text-neutral-500', className)}>
        Run not found.
      </div>
    )
  }

  const { run } = data
  const start = run.startedAt ?? run.createdAt
  const end = run.finishedAt ?? (run.status === 'running' ? Date.now() : null)
  const canRetry = run.status === 'failed' || run.status === 'cancelled'
  // Resume only makes sense when a specific node failed and we still have the
  // graph (node ids must line up with the recorded steps).
  const canResume =
    run.status === 'failed' &&
    !!data.graph &&
    data.steps.some((s) => s.status === 'failed')

  const selectedNode =
    selectedId && data.graph ? findNode(data.graph, selectedId) : null
  const selectedStep = selectedId
    ? (data.steps.find((s) => s.nodeId === selectedId) ?? null)
    : null

  const handleRetry = (mode: RetryRunMode) => {
    retry.mutate(
      { runId, mode },
      { onSuccess: ({ runId: newRunId }) => navigate(`runs/${newRunId}`) },
    )
  }

  return (
    <WfShell
      className={className}
      titleIcon={<Activity className="size-5 shrink-0 text-sky-500" />}
      crumbs={[
        {
          label: (
            <>
              {triggerLabel(run.triggerKind)}{' '}
              <span className="font-normal text-neutral-400">
                {fmtRelative(run.createdAt)}
              </span>
            </>
          ),
        },
      ]}
      actions={
        <>
          <span className="text-xs text-neutral-500">
            {run.workflowName}
            {data.versionNumber != null ? (
              <span className="text-neutral-400"> v{data.versionNumber}</span>
            ) : null}
          </span>
          <Badge className={cn('border', statusClass[run.status])}>
            {run.status}
          </Badge>
          <span className="text-xs text-neutral-500">
            {fmtTime(run.createdAt)}
          </span>
          <span className="text-xs text-neutral-500">
            {fmtDuration(start, end)}
          </span>
          {canRetry ? (
            <RetryMenu
              canResume={canResume}
              pending={retry.isPending}
              onPick={handleRetry}
            />
          ) : null}
        </>
      }
    >
      <div className="flex h-full flex-col">
        {run.error ? (
          <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {run.error}
          </div>
        ) : null}
        {retry.error ? (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700">
            Retry failed: {(retry.error as Error).message}
          </div>
        ) : null}

        {/* Body: read-only workflow graph on top, node inspector docked below. */}
        <div className="relative min-h-0 flex-1 bg-neutral-50">
          {data.graph ? (
            <WorkflowCanvas
              graph={data.graph}
              readOnly
              nodeStatuses={nodeStatuses}
              onSelectionChange={setSelectedId}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-sm text-neutral-400">
              This run's workflow version is no longer available.
            </div>
          )}
        </div>
        <RunNodeDock node={selectedNode} step={selectedStep} />
      </div>
    </WfShell>
  )
}

// The Retry control: a split button with two modes. "Retry from start" runs the
// latest version fresh; "Resume from failed step" replays completed work on the
// original version and picks up at the failure (disabled when nothing failed).
function RetryMenu({
  canResume,
  pending,
  onPick,
}: {
  canResume: boolean
  pending: boolean
  onPick: (mode: RetryRunMode) => void
}) {
  const { Button } = useWfComponents()
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      <Button size="sm" onClick={() => setOpen((o) => !o)} disabled={pending}>
        <RotateCcw className="size-3.5" />
        {pending ? 'Retrying…' : 'Retry'}
        <ChevronDown className="size-3.5 opacity-70" />
      </Button>
      {open ? (
        <>
          {/* Click-away backdrop. */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-20 mt-1 w-72 overflow-hidden rounded-md border border-neutral-200 bg-white p-1 shadow-lg">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onPick('restart')
              }}
              className="block w-full rounded px-2 py-1.5 text-left hover:bg-neutral-50"
            >
              <div className="text-sm font-medium text-neutral-800">
                Retry from start
              </div>
              <div className="text-xs text-neutral-500">
                Fresh run on the latest workflow version
              </div>
            </button>
            <button
              type="button"
              disabled={!canResume}
              onClick={() => {
                setOpen(false)
                onPick('resume')
              }}
              className="block w-full rounded px-2 py-1.5 text-left hover:bg-neutral-50 disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <div className="text-sm font-medium text-neutral-800">
                Resume from failed step
              </div>
              <div className="text-xs text-neutral-500">
                {canResume
                  ? 'Reuse completed steps · original version'
                  : 'No failed step to resume from'}
              </div>
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}
