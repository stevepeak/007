import { Fragment } from 'react'

import type { WfEvalResultDTO } from '../../../server/protocol'

import { ResultRowView, GroupHeaderRow } from './results-row'
import { ResultsToolbar, Th } from './results-toolbar'
import { useResultsView } from './use-results-view'

// The results table: one row per graded sample, with group-by, sort, filters,
// an expandable per-check detail, and crowns on the best / fastest / cheapest.
// What's shown is decided in `useResultsView`; the controls are
// `ResultsToolbar`; a row is `ResultRowView`. This is the frame around them.
export function ResultsTable({
  results,
  runStatus,
  highlightedCell,
}: {
  results: WfEvalResultDTO[]
  /**
   * The umbrella run's status, used only to word the empty state. Every cell
   * now writes a row (pass, fail, or error), so an empty table on a finished
   * run is a real, final answer — not something still on its way.
   */
  runStatus?: string
  /** Matrix cell key to highlight — every row in that cell tints (from card hover). */
  highlightedCell?: string | null
}) {
  const view = useResultsView(results)
  const { rows, filtered, sorted, groups, isMatrix, sort, setSort } = view

  const subtitle = `${filtered.length}${
    filtered.length !== rows.length ? ` of ${rows.length}` : ''
  } result${rows.length === 1 ? '' : 's'}`

  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      {/* Static header — the Results section no longer collapses. */}
      <div className="flex w-full items-center gap-2 px-4 py-2.5">
        <span className="text-sm font-semibold text-neutral-900">Results</span>
        <span className="text-xs text-neutral-400">{subtitle}</span>
      </div>
      <ResultsToolbar view={view} />

      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-neutral-400">
          {runStatus === 'queued' || runStatus === 'running'
            ? 'No results yet.'
            : 'This run produced no results.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-[11px] uppercase tracking-wide text-neutral-400">
                <th className="w-6" />
                <Th label="Status" k="status" sort={sort} setSort={setSort} />
                <Th label="Sample" k="sample" sort={sort} setSort={setSort} />
                {isMatrix && <Th label="Model" k="model" sort={sort} setSort={setSort} />}
                {isMatrix && <Th label="Prompt" k="prompt" sort={sort} setSort={setSort} />}
                <Th label="Score" k="score" sort={sort} setSort={setSort} align="right" />
                <Th label="Speed" k="duration" sort={sort} setSort={setSort} align="right" />
                <Th label="Cost" k="cost" sort={sort} setSort={setSort} align="right" />
                <Th label="Tokens" k="tokens" sort={sort} setSort={setSort} align="right" />
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {groups == null
                ? sorted.map((r) => (
                    <ResultRowView
                      key={r.result.id}
                      row={r}
                      view={view}
                      highlightedCell={highlightedCell}
                    />
                  ))
                : groups.map((g) => (
                    <Fragment key={g.key}>
                      <GroupHeaderRow
                        groupKey={g.key}
                        label={g.label}
                        rows={g.rows}
                        view={view}
                      />
                      {!view.collapsedGroups.has(g.key) &&
                        g.rows.map((r) => (
                          <ResultRowView
                            key={r.result.id}
                            row={r}
                            view={view}
                            highlightedCell={highlightedCell}
                          />
                        ))}
                    </Fragment>
                  ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
