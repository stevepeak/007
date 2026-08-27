import { Activity } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { RetryRunMode } from '../server/protocol'

import { cn } from './cn'
import { WorkflowCanvas } from './editor/workflow-canvas'
import { useChildRuns, useRetryRun, useRun } from './hooks'
import { useFeedbackForSubjects } from './hooks-feedback'
import { useWfNav } from './nav'
import { QueryState } from './query-state'
import { runAgentVersions } from './run-agent-versions'
import { RunNodeDock } from './run-node-dock'
import { RunNote } from './run-note'
import { RunHeaderActions } from './run-page-header'
import {
  canSpawnChildRuns,
  isRunLive,
  resolveRunSelection,
  topLevelStatuses,
} from './run-selection'
import { WfShell } from './shell'
import { useTickingNow } from './use-now'

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

/**
 * How a child run names its position in the parent's fan-out.
 *
 * `total` is the sibling count once it has loaded — a durable iteration spawns
 * one run per item, so the number of children IS the number of items. Null
 * until then, and the label degrades to the position alone rather than
 * rendering a placeholder total that would be wrong for a moment.
 *
 * Returns null for a workflow-call callee: one callee per node means there is
 * no position, and "Item 1 of 1" would invent a fan-out that never happened.
 */
function itemCrumbLabel(
  itemIndex: number | null,
  total: number | null,
): string | null {
  if (itemIndex == null) return null
  return total != null && total > 0
    ? `Item ${itemIndex + 1} of ${total}`
    : `Item ${itemIndex + 1}`
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
export type RunPageProps = {
  runId: string
  /** Select this node as soon as the run loads, with the dock on Inspect —
   *  a deep link that hands over an investigation already in progress (the
   *  agent editor's "Recent calls" rows link in this way). */
  initialNodeId?: string | null
  /** The iteration item to focus alongside `initialNodeId`. */
  initialItemIndex?: number | null
  className?: string
}

export function RunPage({
  runId,
  initialNodeId,
  initialItemIndex,
  className,
}: RunPageProps) {
  const { navigate } = useWfNav()
  const { data, isLoading, error } = useRun(runId)
  // A live run's elapsed time has to keep moving, so this one clock ticks — and
  // stops the moment the run settles, since a finished run's duration is fixed
  // and re-rendering the page every second for an unchanging number is waste.
  const now = useTickingNow(isRunLive(data?.run.status ?? '') ? 1000 : null)
  // The runs this one spawned — durable iteration items, durable callees. Only
  // fetched for a run whose graph can actually spawn any, and only polled while
  // the parent is live, since that is when children appear and change state.
  const spawnsChildren = useMemo(
    () => canSpawnChildRuns(data?.graph ?? null),
    [data?.graph],
  )
  const { data: childRuns } = useChildRuns(runId, {
    enabled: spawnsChildren,
    live: isRunLive(data?.run.status ?? ''),
  })
  // The runs this one's PARENT spawned — this run's siblings. Same query key as
  // the parent's own child list, so arriving here from the parent's dock is a
  // cache hit rather than a second fetch. Only ever asked for by a child run.
  const { data: siblingRuns } = useChildRuns(data?.run.parent?.runId ?? null, {
    live: isRunLive(data?.run.status ?? ''),
  })
  const retry = useRetryRun()
  // Run-level thumbs feedback. Namespaced so a run's rating never collides with a
  // message/document sharing the same host id in the globally-unique subject key.
  const feedbackSubjectId = `run:${runId}`
  const { data: feedbackRows } = useFeedbackForSubjects([feedbackSubjectId])
  const feedback = feedbackRows?.[0] ?? null
  const [selectedId, setSelectedId] = useState<string | null>(
    initialNodeId ?? null,
  )
  // Which iteration item the dock is focused on when an inner-subgraph node is
  // selected. Clamped at read time in `resolveRunSelection`, so it survives
  // switching between iterations of different lengths without a reset.
  const [selectedItemIndex, setSelectedItemIndex] = useState(
    initialItemIndex ?? 0,
  )

  const topLevel = useMemo(
    () => topLevelStatuses(data?.graph, data?.steps ?? [], data?.run.status),
    [data],
  )

  // A deep link's node is selected once, as soon as the canvas exists: going
  // through the canvas's own selector (rather than state alone) also tints the
  // card and pans to it, so the node the link named is the one you're looking
  // at. Once only — after that the selection is yours.
  const selectNodeRef = useRef<((nodeId: string) => void) | null>(null)
  const registerSelectNode = useCallback(
    (select: (nodeId: string) => void) => {
      selectNodeRef.current = select
    },
    [],
  )
  const appliedInitialNodeRef = useRef(false)
  useEffect(() => {
    if (appliedInitialNodeRef.current || !initialNodeId || !data?.graph) return
    appliedInitialNodeRef.current = true
    setSelectedId(initialNodeId)
    selectNodeRef.current?.(initialNodeId)
  }, [initialNodeId, data?.graph])

  // nodeId → the agent version each agent node ran, so its card is labelled with
  // what this run froze rather than whatever the agent has published since.
  // Includes iteration inner steps — those nodes are on the canvas too.
  const agentVersions = useMemo(
    () => runAgentVersions(data?.steps ?? []),
    [data?.steps],
  )

  const handleRetry = useCallback(
    (mode: RetryRunMode) => {
      retry.mutate(
        { runId, mode },
        { onSuccess: ({ runId: newRunId }) => navigate(`runs/${newRunId}`) },
      )
    },
    [retry, runId, navigate],
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
        const live = isRunLive(run.status)
        const itemCrumb = run.parent
          ? itemCrumbLabel(run.parent.itemIndex, siblingRuns?.length ?? null)
          : null
        const selection = resolveRunSelection({
          graph: data.graph,
          steps: data.steps,
          runStatus: run.status,
          selectedId,
          selectedItemIndex,
          topLevel,
        })

        return (
          <WfShell
            className={className}
            titleIcon={<Activity className="size-5 shrink-0 text-sky-500" />}
            crumbs={[
              // A child run is a fragment of something bigger, and landing on
              // one from a link (or a bookmark) otherwise gives no sign of
              // that — nor any way back up. The parent link is the only route:
              // a child's own trace says nothing about who spawned it.
              ...(run.parent
                ? [
                    // Named, and pointing at the parent RUN. "Item 30 of 32" on
                    // its own says which fragment this is but not what it is a
                    // fragment OF, and a durable callee runs a different
                    // workflow from its parent — so the name has to come from
                    // the parent rather than from this run.
                    {
                      label: run.parent.workflowName ?? 'Parent run',
                      to: `runs/${run.parent.runId}`,
                    },
                  ]
                : []),
              ...(itemCrumb ? [{ label: itemCrumb }] : []),
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
              <RunHeaderActions
                run={run}
                versionNumber={data.versionNumber}
                now={now}
                feedbackSubjectId={feedbackSubjectId}
                feedbackRating={feedback?.rating ?? null}
                feedbackNote={feedback?.note ?? null}
                // Any terminal run can be re-run from scratch on the latest
                // version — including ones that completed successfully.
                canRetry={!live}
                // Resume only makes sense when a specific node failed and we
                // still have the graph (node ids must line up with the steps).
                canResume={
                  run.status === 'failed' &&
                  !!data.graph &&
                  data.steps.some((s) => s.status === 'failed')
                }
                retryPending={retry.isPending}
                onRetry={handleRetry}
                siblings={siblingRuns}
              />
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
                  Retry failed: {retry.error.message}
                </div>
              ) : null}
              {/* Directly under the error it usually explains, and above the
                  graph — the note is the human reading of the run, so it wants
                  to be the first thing seen, not something found in a tab. */}
              <RunNote runId={run.id} note={run.note} />

              {/* Body: read-only workflow graph on top, node inspector docked below. */}
              <div className="relative min-h-0 flex-1 bg-neutral-50">
                {data.graph ? (
                  <WorkflowCanvas
                    graph={data.graph}
                    readOnly
                    nodeStatuses={selection.canvasStatuses}
                    nodeAgentVersions={agentVersions}
                    onSelectionChange={setSelectedId}
                    registerSelectNode={registerSelectNode}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center p-6 text-sm text-neutral-400">
                    This run&apos;s workflow version is no longer available.
                  </div>
                )}
              </div>
              <RunNodeDock
                node={selection.selectedNode}
                step={selection.selectedStep}
                steps={data.steps}
                logs={data.logs}
                childRuns={childRuns}
                logsTruncated={data.logsTruncated}
                graph={data.graph}
                live={live}
                // A deep link arrives pointing AT a node, so open on that node's
                // trace rather than the run-wide feed it would have to be found in.
                initialTab={initialNodeId ? 'logs' : 'activity'}
                selectedNodeId={selectedId}
                onSelectNode={setSelectedId}
                // Per-item picker: only meaningful when inspecting a node INSIDE an
                // iteration, where itemIndex selects which recorded item to show.
                itemIndex={selection.parentIterationId ? selection.itemIndex : null}
                itemCount={selection.parentIterationId ? selection.itemCount : 0}
                onSelectItem={setSelectedItemIndex}
              />
            </div>
          </WfShell>
        )
      }}
    </QueryState>
  )
}
