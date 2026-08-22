import { useEffect, useMemo, useState } from 'react'

import type { WfRunListInput, WfRunSummary } from '../server/protocol'

import { cn } from './cn'
import { useWfComponents } from './context'
import { formatDuration, formatTimestamp, formatUsd } from './cost'
import { DeleteAllRunsButton } from './delete-all-runs-button'
import { FilterPill } from './filters'
import { useRuns, useWorkflows } from './hooks'
import { useWfNav } from './nav'
import { RunStatusBadge } from './run-status'
import { useModifierHold } from './use-modifier-hold'
import { usePickedAt } from './use-now'

// Interface #2 — the runs explorer. A dense, server-filtered, paginated table
// built for thousands of runs: search by workflow name / trigger / reference,
// filter by status, workflow, and timeframe. Clicking a row opens that
// run's full-page viewer. All querying happens server-side (see `listRuns`), so
// the browser only ever holds one page.

const STATUS_OPTIONS = [
  'queued',
  'running',
  'done',
  'completed',
  'failed',
  'cancelled',
] as const

// Timeframe presets → a lookback window in milliseconds. `''` (all time) is the
// unset state, so the Time pill renders dashed like the other three.
const TIMEFRAMES: { value: string; label: string; ms: number }[] = [
  { value: '1h', label: 'Last hour', ms: 60 * 60 * 1000 },
  { value: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
]

function fmtDuration(run: WfRunSummary): string {
  const start = run.startedAt ?? run.createdAt
  const end = run.finishedAt ?? (run.status === 'running' ? Date.now() : null)
  return formatDuration(start, end)
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])
  return debounced
}

export type RunsExplorerProps = {
  /** Scope the table to a single workflow (hides the workflow filter). */
  workflowId?: string
  /**
   * Pre-select the workflow filter (the dropdown stays visible and adjustable).
   * Ignored when `workflowId` locks the scope. Use this to deep-link into the
   * runs table filtered to one workflow, e.g. `runs?workflow=<id>`.
   */
  initialWorkflowId?: string
  /** Rows per page (server-enforced ceiling is 200). */
  pageSize?: number
  className?: string
}

export function RunsExplorer({
  workflowId,
  initialWorkflowId,
  pageSize = 50,
  className,
}: RunsExplorerProps) {
  const { Input } = useWfComponents()
  const { navigate } = useWfNav()

  const [searchRaw, setSearchRaw] = useState('')
  const search = useDebounced(searchRaw, 300)
  const [status, setStatus] = useState('')
  const [workflowFilter, setWorkflowFilter] = useState(initialWorkflowId ?? '')
  const [timeframe, pickedAt, setTimeframe] = usePickedAt('')
  const [page, setPage] = useState(0)

  // Any filter change returns to the first page.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- return to page 1 when a filter changes
    setPage(0)
  }, [search, status, workflowFilter, timeframe])

  const workflows = useWorkflows()
  // Cmd + Option reveals the purge control. A different combo from the everyday
  // Cmd + Control reveals, so an irreversible action can't surface by muscle
  // memory. Once revealed it LATCHES for the life of the page: the button (and
  // its confirm dialog) must survive letting go of the keys to click it.
  // Leaving the runs explorer unmounts it and hides the control again.
  const purgeHeld = useModifierHold('meta+alt')
  const [purgeRevealed, setPurgeRevealed] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- latch on a transient external input (a held modifier)
    if (purgeHeld) setPurgeRevealed(true)
  }, [purgeHeld])

  // Anchored to the instant the timeframe was picked, not read per render —
  // paging through results must not quietly slide the window out from under the
  // offsets.
  const input = useMemo<WfRunListInput>(() => {
    const frame = TIMEFRAMES.find((t) => t.value === timeframe)
    return {
      workflowId: workflowId ?? (workflowFilter || undefined),
      status: status || undefined,
      search: search.trim() || undefined,
      since: frame ? pickedAt - frame.ms : undefined,
      limit: pageSize,
      offset: page * pageSize,
    }
  }, [
    pickedAt,
    workflowId,
    workflowFilter,
    status,
    search,
    timeframe,
    page,
    pageSize,
  ])

  const runsQuery = useRuns(input)
  const result = runsQuery.data
  const runs = result?.runs ?? []
  const total = result?.total ?? 0
  const from = total === 0 ? 0 : page * pageSize + 1
  const to = Math.min(total, page * pageSize + runs.length)
  const hasNext = (page + 1) * pageSize < total
  const hasPrev = page > 0

  const hasFilters =
    !!search.trim() ||
    !!status ||
    !!workflowFilter ||
    !!timeframe

  function resetFilters() {
    setSearchRaw('')
    setStatus('')
    setWorkflowFilter('')
    setTimeframe('')
  }

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 px-3 py-2.5">
        <Input
          value={searchRaw}
          onChange={(e) => setSearchRaw(e.target.value)}
          placeholder="Search workflow, trigger, or reference…"
          className="h-9 w-64"
        />
        <FilterPill
          label="Status"
          value={status}
          onChange={setStatus}
          options={STATUS_OPTIONS.map((s) => ({
            value: s,
            label: s,
            node: <RunStatusBadge status={s} />,
          }))}
        />
        {!workflowId ? (
          <FilterPill
            label="Workflow"
            value={workflowFilter}
            onChange={setWorkflowFilter}
            searchPlaceholder="Search workflows…"
            options={(workflows.data ?? []).map((w) => ({
              value: w.id,
              label: w.name,
            }))}
          />
        ) : null}
        <FilterPill
          label="Time"
          value={timeframe}
          onChange={setTimeframe}
          options={TIMEFRAMES.map((t) => ({ value: t.value, label: t.label }))}
        />
        {hasFilters ? (
          <button
            type="button"
            onClick={resetFilters}
            className="text-sm text-neutral-500 hover:text-neutral-800 hover:underline"
          >
            Clear
          </button>
        ) : null}
        {purgeRevealed ? <DeleteAllRunsButton className="ml-auto" /> : null}
        <div
          className={cn(
            'text-xs text-neutral-500',
            purgeRevealed ? null : 'ml-auto',
          )}
        >
          {/* Not a QueryState ladder: this surface's states are scattered
              across three separate chrome slots — the count chip here, the
              placeholder row in the table body, and the pager below — so no
              single wrapper owns a region to sequence. */}
          {runsQuery.isLoading
            ? 'Loading…'
            : total === 0
              ? 'No runs'
              : `${from}–${to} of ${total.toLocaleString()}`}
        </div>
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-neutral-50 text-left text-xs font-medium text-neutral-500">
            <tr className="border-b border-neutral-200">
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Workflow</th>
              <th className="px-3 py-2 font-medium">Started</th>
              <th className="px-3 py-2 text-right font-medium">Duration</th>
              <th className="px-3 py-2 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr
                key={r.id}
                onClick={() => navigate(`runs/${r.id}`)}
                className="cursor-pointer border-b border-neutral-100 hover:bg-neutral-50"
              >
                <td className="px-3 py-2">
                  <RunStatusBadge status={r.status} />
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-medium text-neutral-800">
                      {r.workflowName}
                    </span>
                    <span className="text-xs text-neutral-400">
                      v{r.versionNumber}
                    </span>
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-neutral-600">
                  {formatTimestamp(r.createdAt)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right text-neutral-600">
                  {fmtDuration(r)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right text-neutral-600 tabular-nums">
                  {r.costUsd != null ? (
                    <span
                      title={
                        r.totalTokens != null
                          ? `${r.totalTokens.toLocaleString()} tokens`
                          : undefined
                      }
                    >
                      {formatUsd(r.costUsd)}
                    </span>
                  ) : (
                    <span className="text-neutral-300">—</span>
                  )}
                </td>
              </tr>
            ))}
            {!runsQuery.isLoading && runs.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-12 text-center text-sm text-neutral-400"
                >
                  {hasFilters ? 'No runs match these filters.' : 'No runs yet.'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between border-t border-neutral-200 px-3 py-2 text-sm">
        <div className="text-xs text-neutral-500">
          Page {page + 1} of {Math.max(1, Math.ceil(total / pageSize))}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={!hasPrev}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium hover:bg-neutral-100 disabled:pointer-events-none disabled:opacity-40"
          >
            ← Prev
          </button>
          <button
            type="button"
            disabled={!hasNext}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium hover:bg-neutral-100 disabled:pointer-events-none disabled:opacity-40"
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  )
}
