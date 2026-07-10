import { useEffect, useMemo, useState } from 'react'

import type { WfRunListInput, WfRunSummary } from '../server/protocol'
import { useWfComponents } from './context'
import { cn } from './cn'
import { useRuns, useRunTriggerKinds, useWorkflows } from './hooks'
import { useWfNav } from './nav'

// Interface #2 — the runs explorer. A dense, server-filtered, paginated table
// built for thousands of runs: search by workflow name / trigger / reference,
// filter by trigger kind, status, and timeframe. Clicking a row opens that
// run's full-page viewer. All querying happens server-side (see `listRuns`), so
// the browser only ever holds one page.

const statusClass: Record<string, string> = {
  completed: 'bg-green-100 text-green-700 border-green-200',
  running: 'bg-blue-100 text-blue-700 border-blue-200',
  failed: 'bg-red-100 text-red-700 border-red-200',
  queued: 'bg-amber-100 text-amber-700 border-amber-200',
  cancelled: 'bg-neutral-100 text-neutral-500 border-neutral-200',
}

const STATUS_OPTIONS = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const

// Timeframe presets → a lookback window in milliseconds (null = all time).
const TIMEFRAMES: { label: string; ms: number | null }[] = [
  { label: 'All time', ms: null },
  { label: 'Last hour', ms: 60 * 60 * 1000 },
  { label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
]

function fmtTime(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function fmtDuration(run: WfRunSummary): string {
  const start = run.startedAt ?? run.createdAt
  const end = run.finishedAt ?? (run.status === 'running' ? Date.now() : null)
  if (end == null) return '—'
  const secs = Math.max(0, Math.round((end - start) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const rem = secs % 60
  if (mins < 60) return `${mins}m ${rem}s`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m`
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])
  return debounced
}

// A native <select> styled to match the injected Input primitive.
function Select({
  value,
  onChange,
  children,
  className,
  'aria-label': ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  children: React.ReactNode
  className?: string
  'aria-label'?: string
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'h-9 rounded-md border border-neutral-300 bg-transparent px-2.5 text-sm outline-none focus:border-neutral-500',
        className,
      )}
    >
      {children}
    </select>
  )
}

function StatusBadge({ status }: { status: string }) {
  const { Badge } = useWfComponents()
  return <Badge className={cn('border', statusClass[status])}>{status}</Badge>
}

export type RunsExplorerProps = {
  /** Scope the table to a single workflow (hides the workflow filter). */
  workflowId?: string
  /** Rows per page (server-enforced ceiling is 200). */
  pageSize?: number
  className?: string
}

export function RunsExplorer({
  workflowId,
  pageSize = 50,
  className,
}: RunsExplorerProps) {
  const { Input } = useWfComponents()
  const { navigate } = useWfNav()

  const [searchRaw, setSearchRaw] = useState('')
  const search = useDebounced(searchRaw, 300)
  const [triggerKind, setTriggerKind] = useState('')
  const [status, setStatus] = useState('')
  const [workflowFilter, setWorkflowFilter] = useState('')
  const [timeframeIdx, setTimeframeIdx] = useState(0)
  const [page, setPage] = useState(0)

  // Any filter change returns to the first page.
  useEffect(() => {
    setPage(0)
  }, [search, triggerKind, status, workflowFilter, timeframeIdx])

  const triggerKinds = useRunTriggerKinds()
  const workflows = useWorkflows()

  const input = useMemo<WfRunListInput>(() => {
    const frame = TIMEFRAMES[timeframeIdx]
    return {
      workflowId: workflowId ?? (workflowFilter || undefined),
      triggerKind: triggerKind || undefined,
      status: status || undefined,
      search: search.trim() || undefined,
      since: frame?.ms != null ? Date.now() - frame.ms : undefined,
      limit: pageSize,
      offset: page * pageSize,
    }
  }, [
    workflowId,
    workflowFilter,
    triggerKind,
    status,
    search,
    timeframeIdx,
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
    !!triggerKind ||
    !!status ||
    !!workflowFilter ||
    timeframeIdx !== 0

  function resetFilters() {
    setSearchRaw('')
    setTriggerKind('')
    setStatus('')
    setWorkflowFilter('')
    setTimeframeIdx(0)
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
        <Select
          aria-label="Trigger kind"
          value={triggerKind}
          onChange={setTriggerKind}
        >
          <option value="">All triggers</option>
          {triggerKinds.data?.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Select>
        <Select aria-label="Status" value={status} onChange={setStatus}>
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        {!workflowId ? (
          <Select
            aria-label="Workflow"
            value={workflowFilter}
            onChange={setWorkflowFilter}
          >
            <option value="">All workflows</option>
            {workflows.data?.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        ) : null}
        <Select
          aria-label="Timeframe"
          value={String(timeframeIdx)}
          onChange={(v) => setTimeframeIdx(Number(v))}
        >
          {TIMEFRAMES.map((t, i) => (
            <option key={t.label} value={i}>
              {t.label}
            </option>
          ))}
        </Select>
        {hasFilters ? (
          <button
            type="button"
            onClick={resetFilters}
            className="text-sm text-neutral-500 hover:text-neutral-800 hover:underline"
          >
            Clear
          </button>
        ) : null}
        <div className="ml-auto text-xs text-neutral-500">
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
              <th className="px-3 py-2 font-medium">Trigger</th>
              <th className="px-3 py-2 font-medium">Started</th>
              <th className="px-3 py-2 text-right font-medium">Duration</th>
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
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-3 py-2">
                  <div className="font-medium text-neutral-800">
                    {r.workflowName}
                  </div>
                  <div className="text-xs text-neutral-400">
                    v{r.versionNumber}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <span className="font-mono text-xs text-neutral-600">
                    {r.triggerKind}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-neutral-600">
                  {fmtTime(r.createdAt)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right text-neutral-600">
                  {fmtDuration(r)}
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
