import { cn } from './cn'
import { useWfComponents } from './context'
import { DeleteAllRunsButton } from './delete-all-runs-button'
import { FilterPill } from './filters'
import { RunStatusBadge } from './run-status'
import { RunsPager, RunsTable } from './runs-explorer-table'
import { TIMEFRAMES, useRunsQuery } from './use-runs-query'

// Interface #2 — the runs explorer. A dense, server-filtered, paginated table
// built for thousands of runs: search by workflow name / trigger / reference,
// filter by status, workflow, and timeframe. Clicking a row opens that
// run's full-page viewer. All querying happens server-side (see `listRuns`), so
// the browser only ever holds one page.
//
// The filters and the query they build are in `useRunsQuery`; the table and
// pager are in `runs-explorer-table`. This file is the filter bar and layout.

const STATUS_OPTIONS = [
  'queued',
  'running',
  'done',
  'completed',
  'failed',
  'cancelled',
] as const

export type RunsExplorerProps = {
  /** Scope the table to a single workflow (hides the workflow filter). */
  workflowId?: string
  /**
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
  const q = useRunsQuery({ workflowId, initialWorkflowId, pageSize })

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 px-3 py-2.5">
        <Input
          value={q.searchRaw}
          onChange={(e) => q.setSearchRaw(e.target.value)}
          placeholder="Search workflow, trigger, or reference…"
          className="h-9 w-64"
        />
        <FilterPill
          label="Status"
          value={q.status}
          onChange={q.setStatus}
          options={STATUS_OPTIONS.map((s) => ({
            value: s,
            label: s,
            node: <RunStatusBadge status={s} />,
          }))}
        />
        {!workflowId ? (
          <FilterPill
            label="Workflow"
            value={q.workflowFilter}
            onChange={q.setWorkflowFilter}
            searchPlaceholder="Search workflows…"
            options={(q.workflows.data ?? []).map((w) => ({
              value: w.id,
              label: w.name,
            }))}
          />
        ) : null}
        <FilterPill
          label="Time"
          value={q.timeframe}
          onChange={q.setTimeframe}
          options={TIMEFRAMES.map((t) => ({ value: t.value, label: t.label }))}
        />
        {q.hasFilters ? (
          <button
            type="button"
            onClick={q.resetFilters}
            className="text-sm text-neutral-500 hover:text-neutral-800 hover:underline"
          >
            Clear
          </button>
        ) : null}
        {q.purgeRevealed ? <DeleteAllRunsButton className="ml-auto" /> : null}
        <div
          className={cn(
            'text-xs text-neutral-500',
            q.purgeRevealed ? null : 'ml-auto',
          )}
        >
          {/* Not a QueryState ladder: this surface's states are scattered
              across three separate chrome slots — the count chip here, the
              placeholder row in the table body, and the pager below — so no
              single wrapper owns a region to sequence. */}
          {q.isLoading
            ? 'Loading…'
            : q.total === 0
              ? 'No runs'
              : `${q.from}–${q.to} of ${q.total.toLocaleString()}`}
        </div>
      </div>

      <RunsTable
        runs={q.runs}
        isLoading={q.isLoading}
        hasFilters={q.hasFilters}
      />

      <RunsPager
        page={q.page}
        pageCount={q.pageCount}
        hasPrev={q.hasPrev}
        hasNext={q.hasNext}
        onPage={q.setPage}
      />
    </div>
  )
}
