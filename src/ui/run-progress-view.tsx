import { AlertCircle, CheckCircle2, ChevronDown, Loader2 } from 'lucide-react'
import { useState } from 'react'

import { cn } from './cn'
import { useWfComponents } from './context'

// The reusable, presentational "what's happening" surface for a workflow run —
// a first-class 007 export any SDK client can drop in. It is TRANSPORT-AGNOSTIC:
// a feeder (an SSE hook, the editor simulator, a host's own stream) turns run
// signals into `RunSurfaceItem[]` + a `{completed,total}` count and hands them
// here. It renders a progress bar, the current message, and an expandable
// timeline — and is deliberately shaped to grow interactive feedback (a node
// pausing to ask the user a question, or offering an action) without reshaping:
// the `prompt`/`action` item kinds are rendered today but only call back through
// `onFeedback`; wiring their answers upstream is a later phase.

/** One element of the run's user-facing surface. */
export type RunSurfaceItem =
  | { kind: 'progress'; message: string; nodeId?: string; ts?: number }
  | {
      kind: 'prompt'
      question: string
      options: { label: string; value: string }[]
      nodeId?: string
      ts?: number
    }
  | {
      kind: 'action'
      label: string
      actionId: string
      nodeId?: string
      ts?: number
    }

export type RunSurfaceStatus = 'running' | 'completed' | 'failed'

/** A user's answer to a `prompt`/`action` item, handed back to the host. */
export type RunSurfaceFeedback =
  { kind: 'prompt'; value: string } | { kind: 'action'; actionId: string }

export type WorkflowRunProgressProps = {
  items: RunSurfaceItem[]
  /** Drives the determinate bar. Omit (or total 0) → an indeterminate bar. */
  progress?: { completed: number; total: number }
  status?: RunSurfaceStatus
  /** Called when the user answers a `prompt` or triggers an `action`. */
  onFeedback?: (response: RunSurfaceFeedback) => void
  className?: string
}

function latestProgress(items: RunSurfaceItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'progress') return it.message
  }
  return null
}

export function WorkflowRunProgress({
  items,
  progress,
  status = 'running',
  onFeedback,
  className,
}: WorkflowRunProgressProps) {
  const [open, setOpen] = useState(false)
  const running = status === 'running'
  const current =
    status === 'failed'
      ? 'Something went wrong'
      : status === 'completed'
        ? 'Done'
        : (latestProgress(items) ?? 'Working…')

  const total = progress?.total ?? 0
  const pct =
    status === 'completed'
      ? 100
      : total > 0
        ? Math.min(100, Math.round((progress!.completed / total) * 100))
        : null

  return (
    <div
      className={cn(
        'w-full rounded-lg border border-border bg-background/60 p-3 text-sm',
        className,
      )}
    >
      {/* Progress bar */}
      <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-neutral-200/70 dark:bg-neutral-800">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500 ease-out',
            status === 'failed' ? 'bg-rose-500' : 'bg-emerald-500',
            pct == null && running && 'animate-pulse',
          )}
          style={{ width: pct == null ? '40%' : `${pct}%` }}
        />
      </div>

      {/* Current message + expand toggle */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 text-left"
      >
        {status === 'completed' ? (
          <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
        ) : status === 'failed' ? (
          <AlertCircle className="size-4 shrink-0 text-rose-500" />
        ) : (
          <Loader2 className="size-4 shrink-0 animate-spin text-emerald-500" />
        )}
        <span
          className={cn(
            'flex-1 truncate',
            running && 'text-foreground',
            !running && 'text-muted-foreground',
          )}
        >
          {current}
        </span>
        {items.length > 0 ? (
          <ChevronDown
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-180',
            )}
          />
        ) : null}
      </button>

      {/* Expandable timeline of every surface item */}
      {open && items.length > 0 ? (
        <ol className="mt-2 space-y-1 border-t border-border pt-2">
          {items.map((item, i) => (
            <li key={i}>
              <SurfaceItemRow item={item} onFeedback={onFeedback} />
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}

function SurfaceItemRow({
  item,
  onFeedback,
}: {
  item: RunSurfaceItem
  onFeedback?: (response: RunSurfaceFeedback) => void
}) {
  // Progress rows are pure JSX and use NO injected primitives, so the component
  // renders progress-only feeds (a chat, a status panel) with no `WfSdkProvider`.
  // Only the interactive `prompt`/`action` controls need the injected `Button`,
  // and they live in `FeedbackControls` — mounted (and calling the context hook)
  // solely when such an item is present.
  if (item.kind === 'progress') {
    return (
      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <span className="mt-1 size-1.5 shrink-0 rounded-full bg-emerald-400" />
        <span className="flex-1">{item.message}</span>
      </div>
    )
  }
  return <FeedbackControls item={item} onFeedback={onFeedback} />
}

function FeedbackControls({
  item,
  onFeedback,
}: {
  item: Extract<RunSurfaceItem, { kind: 'prompt' | 'action' }>
  onFeedback?: (response: RunSurfaceFeedback) => void
}) {
  const { Button } = useWfComponents()

  if (item.kind === 'prompt') {
    return (
      <div className="rounded-md bg-muted/40 p-2">
        <p className="mb-1.5 text-xs font-medium">{item.question}</p>
        <div className="flex flex-wrap gap-1.5">
          {item.options.map((opt) => (
            <Button
              key={opt.value}
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => onFeedback?.({ kind: 'prompt', value: opt.value })}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="py-0.5">
      <Button
        variant="outline"
        className="h-7 px-2 text-xs"
        onClick={() =>
          onFeedback?.({ kind: 'action', actionId: item.actionId })
        }
      >
        {item.label}
      </Button>
    </div>
  )
}
