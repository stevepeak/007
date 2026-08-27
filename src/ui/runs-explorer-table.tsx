import { ChevronDown, ChevronRight, CornerDownRight } from 'lucide-react'
import { Fragment, useState } from 'react'

import type { WfRunListRow, WfRunSummary } from '../server/protocol'

import {
  formatDuration,
  formatDurationMs,
  formatTimestamp,
  formatUsd,
} from './cost'
import { useChildRuns } from './hooks'
import { useWfNav } from './nav'
import { RunStatusBadge } from './run-status'
import { firstLine } from './text-preview'

// The runs table itself. Each row opens that run's full-page viewer.
//
// A run that spawned children — a durable iteration's items, or a workflow-call
// node's callee — is one row with a caret, not N+1 unrelated rows: a 12-recipe
// document used to read as thirteen separate runs with nothing tying them
// together. Children are fetched only when a row is expanded (see
// `useChildRuns`), and each is independently clickable through to its own run
// view, which is the entire point of them being separate instances.

const COLUMN_COUNT = 6

export function RunsTable({
  runs,
  isLoading,
  hasFilters,
}: {
  runs: WfRunListRow[]
  isLoading: boolean
  /** Words the empty state: nothing matched vs nothing exists. */
  hasFilters: boolean
}) {
  // Which parents are open, keyed by run id so a poll refresh can't close them.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-neutral-50 text-left text-xs font-medium text-neutral-500">
          <tr className="border-b border-neutral-200">
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Workflow</th>
            <th className="px-3 py-2 font-medium">Note</th>
            <th className="px-3 py-2 font-medium">Started</th>
            <th className="px-3 py-2 text-right font-medium">Duration</th>
            <th className="px-3 py-2 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <Fragment key={r.id}>
              <RunRow
                run={r}
                expanded={expanded.has(r.id)}
                onToggle={() => toggle(r.id)}
              />
              {expanded.has(r.id) ? <ChildRows parentRunId={r.id} /> : null}
            </Fragment>
          ))}
          {!isLoading && runs.length === 0 ? (
            <tr>
              <td
                colSpan={COLUMN_COUNT}
                className="px-3 py-12 text-center text-sm text-neutral-400"
              >
                {hasFilters ? 'No runs match these filters.' : 'No runs yet.'}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )
}

function RunRow({
  run,
  expanded,
  onToggle,
}: {
  run: WfRunListRow
  expanded: boolean
  onToggle: () => void
}) {
  const { navigate } = useWfNav()
  const children = run.children
  return (
    <tr
      onClick={() => navigate(`runs/${run.id}`)}
      className="cursor-pointer border-b border-neutral-100 hover:bg-neutral-50"
    >
      <td className="px-3 py-2">
        <div className="flex items-center gap-1">
          {children ? (
            <button
              type="button"
              aria-label={expanded ? 'Hide child runs' : 'Show child runs'}
              aria-expanded={expanded}
              onClick={(e) => {
                // The row navigates; the caret must not.
                e.stopPropagation()
                onToggle()
              }}
              className="-ml-1 shrink-0 rounded p-0.5 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-600"
            >
              {expanded ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
            </button>
          ) : (
            <span className="w-3.5 shrink-0" />
          )}
          <RunStatusBadge status={run.status} />
        </div>
      </td>
      <td className="px-3 py-2">
        <div className="flex items-baseline gap-1.5">
          <span className="font-medium text-neutral-800">
            {run.workflowName}
          </span>
          <span className="text-xs text-neutral-400">v{run.versionNumber}</span>
          {children ? <ChildSummary counts={children} /> : null}
        </div>
      </td>
      {/* Fixed width + truncate, not `max-w-0`-style flex: the note is
          free text of any length and must not be allowed to squeeze the
          columns either side of it. The full text is the row's title. */}
      <td className="max-w-[18rem] px-3 py-2">
        {run.note ? (
          <div className="truncate text-neutral-600" title={run.note}>
            {firstLine(run.note, 200)}
          </div>
        ) : (
          <span className="text-neutral-300">—</span>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-neutral-600">
        {formatTimestamp(run.createdAt)}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right text-neutral-600">
        {fmtDuration(run)}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right text-neutral-600 tabular-nums">
        <RunCost run={run} hasChildren={!!children} />
      </td>
    </tr>
  )
}

/**
 * The chip that makes a fan-out legible while the row is still COLLAPSED:
 * how many children, how far along, and — the load-bearing part — how many
 * failed.
 *
 * A failed item does not necessarily fail its parent: under `stopOnError:
 * false` the loop fills the slot with a placeholder and the run completes. So a
 * parent can read green while an item inside it burned, and nobody expands a
 * row that looks fine. This is where that shows.
 */
function ChildSummary({
  counts,
}: {
  counts: NonNullable<WfRunListRow['children']>
}) {
  const { total, settled, failed } = counts
  const running = settled < total
  return (
    <span className="flex items-baseline gap-1.5 text-xs">
      <span
        className="text-fuchsia-600 tabular-nums"
        title={`${total} child run${total === 1 ? '' : 's'}`}
      >
        {running ? `${settled}/${total}` : total} item
        {total === 1 ? '' : 's'}
      </span>
      {failed > 0 ? (
        <span
          className="text-rose-600 tabular-nums"
          title="Items that failed. A loop set to carry on past a failure still completes, so this can be non-zero on a run that looks fine."
        >
          {failed} failed
        </span>
      ) : null}
    </span>
  )
}

/**
 * What the row reports under Cost.
 *
 * For a run that spawned nothing this is simply its own total. For a fan-out it
 * is the TREE total — the parent plus every run beneath it — because the run's
 * own figure there is the cost of dispatching a loop, and reading "$0.02" for a
 * 12-recipe document that spent four dollars is worse than reading nothing.
 *
 * The own figure isn't discarded, it moves into the tooltip alongside the
 * additive compute time, which is the number that shows what the fan-out bought:
 * forty minutes of work inside six minutes of wall clock.
 */
function RunCost({
  run,
  hasChildren,
}: {
  run: WfRunSummary
  hasChildren: boolean
}) {
  const tree = run.tree
  const shown = tree?.costUsd ?? run.costUsd
  if (shown == null) return <span className="text-neutral-300">—</span>
  const tokens = tree?.totalTokens ?? run.totalTokens
  const title = [
    tokens != null ? `${tokens.toLocaleString()} tokens` : null,
    tree ? `${tree.runCount} runs in this tree` : null,
    tree?.computeMs != null
      ? `${formatDurationMs(tree.computeMs)} of compute, run concurrently`
      : null,
    tree
      ? `This run itself: ${run.costUsd != null ? formatUsd(run.costUsd) : 'no priced agent calls'}`
      : null,
    // A tree with runs still going is a floor, not a total. Said in words as
    // well as marked with the `+` below, since a bare `+` is easy to miss.
    tree && tree.pending > 0
      ? `${tree.pending} still running — this is the total so far`
      : null,
    !tree && hasChildren
      ? "This run's own cost — its child runs are listed separately, each with theirs."
      : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <span title={title || undefined}>
      {formatUsd(shown)}
      {tree && tree.pending > 0 ? (
        <span className="text-neutral-400">+</span>
      ) : null}
    </span>
  )
}

/** The expanded child rows for one parent, fetched on demand. */
function ChildRows({ parentRunId }: { parentRunId: string }) {
  const { navigate } = useWfNav()
  const { data, isLoading, error } = useChildRuns(parentRunId)

  if (error) {
    return (
      <tr className="border-b border-neutral-100 bg-neutral-50/60">
        <td colSpan={COLUMN_COUNT} className="px-3 py-2 pl-10 text-xs text-rose-600">
          Could not load the child runs: {error.message}
        </td>
      </tr>
    )
  }
  if (isLoading || !data) {
    return (
      <tr className="border-b border-neutral-100 bg-neutral-50/60">
        <td
          colSpan={COLUMN_COUNT}
          className="px-3 py-2 pl-10 text-xs text-neutral-400"
        >
          Loading child runs…
        </td>
      </tr>
    )
  }

  return (
    <>
      {data.map((c) => (
        <tr
          key={c.id}
          onClick={() => navigate(`runs/${c.id}`)}
          className="cursor-pointer border-b border-neutral-100 bg-neutral-50/60 hover:bg-neutral-100"
        >
          <td className="py-1.5 pr-3 pl-9">
            <RunStatusBadge status={c.status} />
          </td>
          <td className="px-3 py-1.5">
            <div className="flex items-baseline gap-1.5">
              <CornerDownRight className="size-3 shrink-0 self-center text-neutral-300" />
              <span className="text-neutral-700">{childLabel(c)}</span>
              {/* A durable iteration item runs the SAME workflow version as its
                  parent, so naming it again would be noise. A callee runs a
                  different workflow, and that name is the whole point. */}
              {c.parent?.itemIndex == null ? (
                <span className="text-xs text-neutral-400">
                  v{c.versionNumber}
                </span>
              ) : null}
            </div>
          </td>
          <td className="max-w-[18rem] px-3 py-1.5">
            {c.error ? (
              <div className="truncate text-xs text-rose-600" title={c.error}>
                {firstLine(c.error, 200)}
              </div>
            ) : c.note ? (
              <div className="truncate text-xs text-neutral-500" title={c.note}>
                {firstLine(c.note, 200)}
              </div>
            ) : (
              <span className="text-neutral-300">—</span>
            )}
          </td>
          <td className="whitespace-nowrap px-3 py-1.5 text-xs text-neutral-500">
            {formatTimestamp(c.createdAt)}
          </td>
          <td className="whitespace-nowrap px-3 py-1.5 text-right text-xs text-neutral-500">
            {fmtDuration(c)}
          </td>
          <td className="whitespace-nowrap px-3 py-1.5 text-right text-xs text-neutral-500 tabular-nums">
            <RunCost run={c} hasChildren={false} />
          </td>
        </tr>
      ))}
      {data.length === 0 ? (
        <tr className="border-b border-neutral-100 bg-neutral-50/60">
          <td
            colSpan={COLUMN_COUNT}
            className="px-3 py-2 pl-10 text-xs text-neutral-400"
          >
            No child runs — they may have been purged.
          </td>
        </tr>
      ) : null}
    </>
  )
}

/** "Item 3" for an iteration item; the callee's workflow name otherwise. */
function childLabel(child: WfRunSummary): string {
  const index = child.parent?.itemIndex
  return index == null ? child.workflowName : `Item ${index + 1}`
}

/** A live run's duration runs to NOW; a settled one's is fixed at its finish. */
function fmtDuration(run: WfRunSummary): string {
  const start = run.startedAt ?? run.createdAt
  const end = run.finishedAt ?? (run.status === 'running' ? Date.now() : null)
  return formatDuration(start, end)
}

export function RunsPager({
  page,
  pageCount,
  hasPrev,
  hasNext,
  onPage,
}: {
  page: number
  pageCount: number
  hasPrev: boolean
  hasNext: boolean
  onPage: (next: number) => void
}) {
  return (
    <div className="flex items-center justify-between border-t border-neutral-200 px-3 py-2 text-sm">
      <div className="text-xs text-neutral-500">
        Page {page + 1} of {pageCount}
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={!hasPrev}
          onClick={() => onPage(Math.max(0, page - 1))}
          className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium hover:bg-neutral-100 disabled:pointer-events-none disabled:opacity-40"
        >
          ← Prev
        </button>
        <button
          type="button"
          disabled={!hasNext}
          onClick={() => onPage(page + 1)}
          className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium hover:bg-neutral-100 disabled:pointer-events-none disabled:opacity-40"
        >
          Next →
        </button>
      </div>
    </div>
  )
}
