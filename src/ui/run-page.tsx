import { Activity, ChevronDown, ExternalLink, RotateCcw } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { WorkflowGraph, WorkflowNode } from '../engine'
import type { RetryRunMode, WfRunStepDTO } from '../server/protocol'
import { useWfComponents } from './context'
import { cn } from './cn'
import { WorkflowCanvas } from './editor/workflow-canvas'
import { formatDuration, formatTimestamp, formatTokens, formatUsd } from './cost'
import { useRetryRun, useRun } from './hooks'
import { useWfNav } from './nav'
import { QueryState } from './query-state'
import { RunNodeDock } from './run-node-dock'
import { runStatusClass } from './run-status'
import { WfShell } from './shell'

// Full-page run viewer. Clicking a row in the runs explorer lands here. The
// centerpiece is the workflow rendered read-only at the exact version that ran,
// with each node tinted by its run status (failed = red). Selecting a node opens
// its Input / Logs / Output in the bottom dock — the graph IS the node list, so
// there's no separate trace column. A failed run can be re-dispatched via Retry.

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

// Find a node by id across the top level AND any iteration container's subgraph.
// `parentIterationId` is the container's id when the match is an inner loop node
// (null at top level) — that's what tells the dock to show a per-item picker and
// resolve the node's step against a chosen item index.
function findNode(
  graph: WorkflowGraph,
  id: string,
): { node: WorkflowNode; parentIterationId: string | null } | null {
  for (const n of graph.nodes) {
    if (n.id === id) return { node: n, parentIterationId: null }
    if (n.kind === 'iteration') {
      const child = n.config.subgraph.nodes.find((c) => c.id === id)
      if (child) return { node: child, parentIterationId: n.id }
    }
  }
  return null
}

// The number of items an iteration node fanned out over, read from its recorded
// step meta (`{ total }`). 0 when the node never ran or isn't an iteration.
function iterationItemCount(step: WfRunStepDTO | null | undefined): number {
  const total = (step?.meta as { total?: unknown } | null)?.total
  return typeof total === 'number' ? total : 0
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
  // Which iteration item the dock is focused on when an inner-subgraph node is
  // selected. Clamped to the node's item count at read time, so it survives
  // switching between iterations of different lengths without a reset.
  const [selectedItemIndex, setSelectedItemIndex] = useState(0)

  // nodeId → status for the top-level graph (the canvas's own nodes), driving
  // the tint + status dots. Iteration inner steps are keyed per item and layered
  // on separately (see `canvasStatuses`) so they don't collide here.
  const nodeStatuses = useMemo(
    () =>
      new Map(
        (data?.steps ?? [])
          .filter((s) => !s.parentNodeId)
          .map((s) => [s.nodeId, s.status]),
      ),
    [data?.steps],
  )

  return (
    <QueryState
      query={{ isLoading, error, data }}
      loading={
        <div className={cn('p-6 text-sm text-neutral-500', className)}>
          Loading run…
        </div>
      }
      error={(error) => (
        <div className={cn('p-6 text-sm text-red-600', className)}>
          {error.message}
        </div>
      )}
      empty={
        <div className={cn('p-6 text-sm text-neutral-500', className)}>
          Run not found.
        </div>
      }
    >
      {(data) => {
        const { run } = data
        const start = run.startedAt ?? run.createdAt
        const end = run.finishedAt ?? (run.status === 'running' ? Date.now() : null)
        const live = run.status === 'running' || run.status === 'queued'
        const canRetry = run.status === 'failed' || run.status === 'cancelled'
        // Resume only makes sense when a specific node failed and we still have the
        // graph (node ids must line up with the recorded steps).
        const canResume =
          run.status === 'failed' &&
          !!data.graph &&
          data.steps.some((s) => s.status === 'failed')

        const found =
          selectedId && data.graph ? findNode(data.graph, selectedId) : null
        const selectedNode = found?.node ?? null
        const parentIterationId = found?.parentIterationId ?? null

        // How many items the relevant iteration fanned out over — for the container's
        // own aggregate step when it's selected, or the parent container's step when
        // an inner node is selected. Drives the per-item picker + the itemIndex clamp.
        const iterationId =
          parentIterationId ??
          (selectedNode?.kind === 'iteration' ? selectedId : null)
        const iterationStep = iterationId
          ? (data.steps.find((s) => s.nodeId === iterationId && !s.parentNodeId) ??
            null)
          : null
        const itemCount = iterationItemCount(iterationStep)
        const itemIndex =
          itemCount > 0 ? Math.min(selectedItemIndex, itemCount - 1) : 0

        // An inner-subgraph node's step is addressed by (nodeId, container, item);
        // a top-level node's step is the single row with no parent.
        const selectedStep = !selectedId
          ? null
          : parentIterationId
            ? (data.steps.find(
                (s) =>
                  s.nodeId === selectedId &&
                  s.parentNodeId === parentIterationId &&
                  s.itemIndex === itemIndex,
              ) ?? null)
            : (data.steps.find((s) => s.nodeId === selectedId && !s.parentNodeId) ??
              null)

        // Canvas tint: top-level statuses, plus — when an iteration or one of its
        // inner nodes is selected — that iteration's inner nodes tinted by the focused
        // item, so stepping through items lights up the subgraph item by item.
        const canvasStatuses = iterationId
          ? new Map([
              ...nodeStatuses,
              ...data.steps
                .filter(
                  (s) => s.parentNodeId === iterationId && s.itemIndex === itemIndex,
                )
                .map((s) => [s.nodeId, s.status] as const),
            ])
          : nodeStatuses

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
                <Badge className={cn('border', runStatusClass[run.status])}>
                  {run.status}
                </Badge>
                {run.sentryTraceUrl ? (
                  <a
                    href={run.sentryTraceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-violet-600 hover:text-violet-700 hover:underline"
                    title="Open this run's distributed trace in Sentry"
                  >
                    <Activity className="size-3.5" />
                    Trace
                    <ExternalLink className="size-3" />
                  </a>
                ) : null}
                <span className="text-xs text-neutral-500">
                  {formatTimestamp(run.createdAt)}
                </span>
                <span className="text-xs text-neutral-500">
                  {formatDuration(start, end)}
                </span>
                {run.costUsd != null ? (
                  <span
                    className="text-xs font-medium text-neutral-600 tabular-nums"
                    title={
                      run.totalTokens != null
                        ? `${run.totalTokens.toLocaleString()} tokens`
                        : undefined
                    }
                  >
                    {formatUsd(run.costUsd)}
                    {run.totalTokens != null ? (
                      <span className="ml-1 font-normal text-neutral-400">
                        · {formatTokens(run.totalTokens)} tok
                      </span>
                    ) : null}
                  </span>
                ) : null}
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
                    nodeStatuses={canvasStatuses}
                    onSelectionChange={setSelectedId}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center p-6 text-sm text-neutral-400">
                    This run's workflow version is no longer available.
                  </div>
                )}
              </div>
              <RunNodeDock
                node={selectedNode}
                step={selectedStep}
                logs={data.logs}
                live={live}
                selectedNodeId={selectedId}
                onSelectNode={setSelectedId}
                // Per-item picker: only meaningful when inspecting a node INSIDE an
                // iteration, where itemIndex selects which recorded item to show.
                itemIndex={parentIterationId ? itemIndex : null}
                itemCount={parentIterationId ? itemCount : 0}
                onSelectItem={setSelectedItemIndex}
              />
            </div>
          </WfShell>
        )
      }}
    </QueryState>
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
