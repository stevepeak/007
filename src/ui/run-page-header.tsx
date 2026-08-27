import { ChevronDown, ExternalLink, Layers, RotateCcw } from 'lucide-react'
import { useMemo, useState } from 'react'

import type {
  RetryRunMode,
  WfRunDetail,
  WfRunSummary,
} from '../server/protocol'
import type { WfFeedbackRating } from '../server/protocol-feedback'

import { cn } from './cn'
import { useWfComponents } from './context'
import {
  formatDuration,
  formatDurationMs,
  formatTimestamp,
  formatTokens,
  formatUsd,
} from './cost'
import { MessageFeedback } from './message-feedback'
import { WfLink } from './nav'
import { runStatusClass, runStatusDotClass } from './run-status'
import { SentryIcon } from './sentry-icon'

// The run viewer's header strip: where it came from, what it cost, how it
// ended, and what you can do about it.
export function RunHeaderActions({
  run,
  versionNumber,
  now,
  feedbackSubjectId,
  feedbackRating,
  feedbackNote,
  canRetry,
  canResume,
  retryPending,
  onRetry,
  siblings,
}: {
  run: WfRunDetail['run']
  versionNumber: number | null
  /** A ticking clock while the run is live; ignored once it has finished. */
  now: number
  feedbackSubjectId: string
  feedbackRating: WfFeedbackRating | null
  feedbackNote: string | null
  canRetry: boolean
  canResume: boolean
  retryPending: boolean
  onRetry: (mode: RetryRunMode) => void
  /**
   * Every run this one's PARENT spawned, including this one. Empty for a
   * top-level run, and for a child whose sibling list hasn't landed yet.
   */
  siblings?: WfRunSummary[]
}) {
  const { Badge } = useWfComponents()
  const start = run.startedAt ?? run.createdAt
  const end = run.finishedAt ?? (run.status === 'running' ? now : null)

  return (
    <>
      <span className="text-xs text-neutral-500">
        <WfLink
          to={`${run.workflowId}/edit`}
          className="hover:text-neutral-800 hover:underline"
          title={`Open ${run.workflowName} in the editor`}
        >
          {run.workflowName}
        </WfLink>
        {/* Outside the link on purpose: the editor opens the workflow's current
            draft, not the frozen version that ran. */}
        {versionNumber != null ? (
          <span className="text-neutral-400"> v{versionNumber}</span>
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
          <SentryIcon className="size-3.5" />
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
      <RunCostStat run={run} />
      <MessageFeedback
        alwaysVisible
        subjectId={feedbackSubjectId}
        rating={feedbackRating}
        note={feedbackNote}
        runId={run.id}
        correlationId={run.correlationId}
        subjectTitle={run.workflowName}
        body={run.error ?? null}
      />
      {run.parent ? (
        <SiblingMenu currentRunId={run.id} siblings={siblings ?? []} />
      ) : null}
      {canRetry ? (
        <RetryMenu
          canResume={canResume}
          pending={retryPending}
          onPick={onRetry}
        />
      ) : null}
    </>
  )
}

/**
 * Jump straight to another run in the same fan-out.
 *
 * A durable iteration's items are separate run instances, so reading one and
 * then reading the next means going up to the parent, finding its child list
 * and coming back down — for every item. That is the wrong shape for the thing
 * people actually do with a fan-out, which is sweep it looking for the ones
 * that went wrong.
 *
 * Every sibling is listed rather than just the failures, and each carries its
 * own status dot: the set is already bounded by the container's `maxItems`, and
 * hiding the successful items would remove the context that makes a failure at
 * item 7 mean anything.
 */
function SiblingMenu({
  currentRunId,
  siblings,
}: {
  currentRunId: string
  siblings: WfRunSummary[]
}) {
  const { Button } = useWfComponents()
  const [open, setOpen] = useState(false)
  // Item order, not spawn order. Children are created as the pool frees slots,
  // so a concurrency-4 loop lands them interleaved — and an author looking for
  // "the third recipe" means the third item.
  const ordered = useMemo(
    () =>
      [...siblings].sort(
        (a, b) => (a.parent?.itemIndex ?? 0) - (b.parent?.itemIndex ?? 0),
      ),
    [siblings],
  )
  // Numbered by the run's own `itemIndex`, not by where it lands in this array,
  // so the button and the breadcrumb can never disagree — a fan-out missing a
  // child would otherwise shift every position after the gap.
  const current = ordered.find((r) => r.id === currentRunId)
  const position = current?.parent?.itemIndex ?? null
  // Nothing to jump BETWEEN: a durable workflow-call spawns exactly one child,
  // and a list that hasn't loaded yet would render a picker with one dead row.
  if (ordered.length < 2) return null
  const failed = ordered.filter((r) => r.status === 'failed').length

  return (
    <div className="relative">
      <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)}>
        <Layers className="size-3.5" />
        {position != null
          ? `${position + 1} of ${ordered.length}`
          : `${ordered.length} runs`}
        {/* The reason to open this at all is usually to find the ones that
            broke, and `stopOnError: false` means a green parent can be hiding
            them — so the count that matters rides on the closed button. */}
        {failed > 0 ? (
          <span className="rounded-full bg-red-100 px-1.5 text-[11px] font-medium text-red-700">
            {failed}
          </span>
        ) : null}
        <ChevronDown className="size-3.5 opacity-70" />
      </Button>
      {open ? (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-20 mt-1 w-64 overflow-hidden rounded-md border border-neutral-200 bg-white shadow-lg">
            <div className="border-b border-neutral-100 px-2 py-1.5 text-xs text-neutral-500">
              {ordered.length} runs in this fan-out
              {failed > 0 ? (
                <span className="text-red-600"> · {failed} failed</span>
              ) : null}
            </div>
            {/* Capped by height rather than by count: a 60-item loop should
                still list all 60, just behind a scroll. */}
            <div className="max-h-80 overflow-y-auto p-1">
              {ordered.map((r, i) => {
                const isCurrent = r.id === currentRunId
                return (
                  <WfLink
                    key={r.id}
                    to={`runs/${r.id}`}
                    onClick={() => setOpen(false)}
                    className={cn(
                      'flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-neutral-50',
                      isCurrent
                        ? 'bg-neutral-100 font-medium text-neutral-900'
                        : 'text-neutral-700',
                    )}
                    title={r.error ?? undefined}
                  >
                    <span
                      className={cn(
                        'size-2 shrink-0 rounded-full',
                        runStatusDotClass[r.status] ?? 'bg-neutral-300',
                      )}
                    />
                    <span className="truncate">
                      {r.parent?.itemIndex != null
                        ? `Item ${r.parent.itemIndex + 1}`
                        : `Run ${i + 1}`}
                    </span>
                    <span className="ml-auto shrink-0 text-xs text-neutral-400">
                      {isCurrent ? 'viewing' : r.status}
                    </span>
                  </WfLink>
                )
              })}
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

// The Retry control: a split button with two modes. "Retry from start" runs the
// workflow again from scratch on its latest version; "Resume from failed step"
// reuses the completed steps and picks up where it broke, on the version that
// ran — so it is only offered when a specific step actually failed.
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


/**
 * The header's cost figure — the run's own total, or the TREE total once it has
 * spawned children.
 *
 * A durable fan-out's parent records the loop and little else, so its own cost
 * describes the dispatch rather than the work. Showing that as the run's
 * headline number would understate a multi-recipe upload by an order of
 * magnitude; the own figure moves into the tooltip, beside the additive compute
 * time that says what the concurrency bought.
 */
function RunCostStat({ run }: { run: WfRunSummary }) {
  const tree = run.tree
  const cost = tree?.costUsd ?? run.costUsd
  const tokens = tree?.totalTokens ?? run.totalTokens
  if (cost == null) return null
  const title = [
    tokens != null ? `${tokens.toLocaleString()} tokens` : null,
    tree ? `Across ${tree.runCount} runs, including everything this one spawned` : null,
    tree?.computeMs != null
      ? `${formatDurationMs(tree.computeMs)} of compute, run concurrently`
      : null,
    tree
      ? `This run itself: ${run.costUsd != null ? formatUsd(run.costUsd) : 'no priced agent calls'}`
      : null,
    tree && tree.pending > 0
      ? `${tree.pending} still running — this is the total so far`
      : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <span
      className="text-xs font-medium text-neutral-600 tabular-nums"
      title={title || undefined}
    >
      {formatUsd(cost)}
      {tree && tree.pending > 0 ? (
        <span className="font-normal text-neutral-400">+</span>
      ) : null}
      {tokens != null ? (
        <span className="ml-1 font-normal text-neutral-400">
          · {formatTokens(tokens)} tok
        </span>
      ) : null}
    </span>
  )
}
