import { ChevronDown, ChevronRight, Crown } from 'lucide-react'
import { Fragment } from 'react'

import { cn } from '../../cn'
import { formatDurationMs, formatTokens, formatUsd } from '../../cost'
import { PassRate, Score } from '../shared'

import { StatusDot } from './atoms'
import { cellKey, type ResultRow } from './model'
import { ResultDetail } from './result-detail'
import type { useResultsView } from './use-results-view'

type ResultsView = ReturnType<typeof useResultsView>

/**
 * One graded result, plus its expandable per-check detail. Shared verbatim by
 * the flat and grouped views — a group is only a header row above the same
 * rows, never a different rendering of them.
 */
export function ResultRowView({
  row,
  view,
  highlightedCell,
}: {
  row: ResultRow
  view: ResultsView
  /** Matrix cell key to highlight — from a summary card hover. */
  highlightedCell?: string | null
}) {
  const { bestId, fastestId, cheapestId } = view.crowns
  const open = view.expanded.has(row.result.id)
  // Does this row belong to the matrix cell a summary card is hovering?
  const lit =
    highlightedCell != null &&
    cellKey(row.result.modelId, row.result.promptLabel) === highlightedCell

  return (
    <Fragment>
      <tr
        onClick={() => view.toggle(row.result.id)}
        className={cn(
          'cursor-pointer align-middle transition hover:bg-neutral-50',
          open && 'bg-neutral-50',
          lit && 'bg-emerald-50 hover:bg-emerald-50',
        )}
      >
        <td className="pl-3 text-neutral-400">
          {open ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
        </td>
        {/* Errored rows carry their reason on the dot, so a run full of them
            is readable without expanding every one. */}
        <td className="py-2 pr-3" title={row.error ?? undefined}>
          <StatusDot status={row.status} />
        </td>
        <td className="max-w-[16rem] py-2 pr-3 font-medium text-neutral-800">
          <span className="flex min-w-0 items-center gap-1.5">
            {row.result.id === bestId && (
              <Crown
                className="size-3.5 shrink-0 text-amber-500"
                aria-label="Best results"
              />
            )}
            <span className="truncate">{row.sampleName}</span>
          </span>
        </td>
        {view.isMatrix && (
          <td className="max-w-[10rem] truncate py-2 pr-3 text-neutral-600">
            {row.modelLabel ?? '—'}
          </td>
        )}
        {view.isMatrix && (
          <td className="max-w-[10rem] truncate py-2 pr-3 text-neutral-500">
            {row.promptLabel ?? '—'}
          </td>
        )}
        <td className="py-2 pr-3 text-right tabular-nums">
          <Score value={row.score} />
        </td>
        <td className="py-2 pr-3 text-right tabular-nums text-neutral-600">
          <span className="inline-flex items-center justify-end gap-1">
            {row.result.id === fastestId && (
              <Crown className="size-3 shrink-0 text-amber-500" aria-label="Fastest" />
            )}
            {row.durationMs != null ? formatDurationMs(row.durationMs) : '—'}
          </span>
        </td>
        <td className="py-2 pr-3 text-right tabular-nums text-neutral-600">
          <span className="inline-flex items-center justify-end gap-1">
            {row.result.id === cheapestId && (
              <Crown className="size-3 shrink-0 text-amber-500" aria-label="Cheapest" />
            )}
            {formatUsd(row.costUsd)}
          </span>
        </td>
        <td className="py-2 pr-4 text-right tabular-nums text-neutral-500">
          {row.tokens != null ? formatTokens(row.tokens) : '—'}
        </td>
      </tr>
      {open && (
        <tr className="bg-neutral-50/60">
          <td colSpan={view.cols} className="px-4 pb-3 pt-1">
            <ResultDetail row={row} />
          </td>
        </tr>
      )}
    </Fragment>
  )
}

/** A group's header row — click to fold the group shut. */
export function GroupHeaderRow({
  groupKey,
  label,
  rows,
  view,
}: {
  groupKey: string
  label: string
  rows: ResultRow[]
  view: ResultsView
}) {
  const collapsed = view.collapsedGroups.has(groupKey)
  const passed = rows.filter((r) => r.status === 'pass').length
  return (
    <tr
      onClick={() => view.toggleGroup(groupKey)}
      className="cursor-pointer bg-neutral-100/70 transition hover:bg-neutral-100"
    >
      <td colSpan={view.cols} className="px-3 py-1.5">
        <div className="flex items-center gap-2 text-xs font-semibold text-neutral-600">
          {collapsed ? (
            <ChevronRight className="size-3.5 text-neutral-400" />
          ) : (
            <ChevronDown className="size-3.5 text-neutral-400" />
          )}
          {/* Grouping by status makes the group key a status, so the dot IS the
              label — repeating "pass" as text next to a green dot says nothing. */}
          {view.groupBy === 'status' ? (
            <StatusDot status={groupKey} />
          ) : (
            <span className="text-neutral-700">{label}</span>
          )}
          <PassRate passed={passed} total={rows.length} />
        </div>
      </td>
    </tr>
  )
}
