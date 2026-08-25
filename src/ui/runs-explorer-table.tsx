import type { WfRunSummary } from '../server/protocol'

import { formatDuration, formatTimestamp, formatUsd } from './cost'
import { useWfNav } from './nav'
import { RunStatusBadge } from './run-status'
import { firstLine } from './text-preview'

// The runs table itself. Each row opens that run's full-page viewer.
export function RunsTable({
  runs,
  isLoading,
  hasFilters,
}: {
  runs: WfRunSummary[]
  isLoading: boolean
  /** Words the empty state: nothing matched vs nothing exists. */
  hasFilters: boolean
}) {
  const { navigate } = useWfNav()
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
              {/* Fixed width + truncate, not `max-w-0`-style flex: the note is
                  free text of any length and must not be allowed to squeeze the
                  columns either side of it. The full text is the row's title. */}
              <td className="max-w-[18rem] px-3 py-2">
                {r.note ? (
                  <div
                    className="truncate text-neutral-600"
                    title={r.note}
                  >
                    {firstLine(r.note, 200)}
                  </div>
                ) : (
                  <span className="text-neutral-300">—</span>
                )}
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
          {!isLoading && runs.length === 0 ? (
            <tr>
              <td
                colSpan={6}
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
