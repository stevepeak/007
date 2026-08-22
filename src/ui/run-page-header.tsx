import { ChevronDown, ExternalLink, RotateCcw } from 'lucide-react'
import { useState } from 'react'

import type { RetryRunMode, WfRunDetail } from '../server/protocol'
import type { WfFeedbackRating } from '../server/protocol-feedback'

import { cn } from './cn'
import { useWfComponents } from './context'
import {
  formatDuration,
  formatTimestamp,
  formatTokens,
  formatUsd,
} from './cost'
import { MessageFeedback } from './message-feedback'
import { WfLink } from './nav'
import { runStatusClass } from './run-status'
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
