import { Target } from 'lucide-react'
import { useState } from 'react'

import { useEvalRun } from '../hooks'
import { WfShell } from '../shell'

import { MatrixSummary } from './run-report/matrix-summary'
import { ResultsTable } from './run-report/results-table'
import { RunHeader } from './run-report/run-summary'
import { EmptyState } from './shared'

// The eval run report (route: evals/runs/<evalRunId>). Real-data screen over
// `useEvalRun`, composed from three sections (all in ./run-report): a compact
// run summary, a collapsible model×prompt matrix roll-up, and one
// sortable/filterable/groupable table of every test. Polls while the run is
// still executing so it fills in live. Every section derives from each result's
// frozen `snapshot`, so the report stands alone without re-loading the live sets.

export type EvalRunReportProps = {
  evalRunId: string
  className?: string
}

export function EvalRunReport({ evalRunId, className }: EvalRunReportProps) {
  const { data, isLoading } = useEvalRun(evalRunId)
  // Hovering a "best of" card in the matrix summary lights up that cell's rows
  // in the results table below. Held here so both sections can share it.
  const [hoveredCell, setHoveredCell] = useState<string | null>(null)

  return (
    <WfShell
      crumbs={[
        { home: true },
        { label: 'Run report', icon: Target, iconClassName: 'text-rose-500' },
      ]}
      scroll
      className={className}
    >
      {isLoading && !data ? (
        <EmptyState message="Loading run…" />
      ) : !data ? (
        <EmptyState message="Run not found." />
      ) : (
        <div className="mx-auto max-w-5xl space-y-4 p-6">
          <RunHeader run={data.run} results={data.results} />
          <MatrixSummary results={data.results} onHoverCell={setHoveredCell} />
          <ResultsTable results={data.results} highlightedCell={hoveredCell} />
        </div>
      )}
    </WfShell>
  )
}
