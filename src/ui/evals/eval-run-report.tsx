import { ExternalLink, Target } from 'lucide-react'

import type {
  CheckResult,
  EvalCheck,
  WfEvalResultDTO,
} from '../../server/protocol'
import { cn } from '../cn'
import { useEvalRun, useEvalSet } from '../hooks'
import { WfLink } from '../nav'
import { WfShell } from '../shell'

import { describeCheck, EmptyState, formatTimestamp, PassRate, Score } from './shared'

// The eval run report (route: evals/runs/<evalRunId>). Real-data screen over
// `useEvalRun`: the run's rolled-up pass rate + mean score, then each sample's
// verdict grouped by its Goal (set) — per-check ✓/✗ (and judge score + reason),
// with a link out to the real wf_run the grade came from. Polls while the run is
// still executing so it fills in live.

export type EvalRunReportProps = {
  evalRunId: string
  className?: string
}

export function EvalRunReport({ evalRunId, className }: EvalRunReportProps) {
  const { data, isLoading } = useEvalRun(evalRunId)

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
        <div className="space-y-6">
          <RunHeader run={data.run} />
          {data.run.setIds.length === 0 ? (
            <EmptyState message="This run has no sets." />
          ) : (
            data.run.setIds.map((setId) => (
              <SetSection
                key={setId}
                setId={setId}
                results={data.results}
              />
            ))
          )}
        </div>
      )}
    </WfShell>
  )
}

function RunHeader({ run }: { run: NonNullable<ReturnType<typeof useEvalRun>['data']>['run'] }) {
  const running = run.status === 'queued' || run.status === 'running'
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold text-neutral-900">Eval run</h1>
        <VerdictBadge status={run.status} />
        {running && (
          <span className="text-xs text-neutral-400">updating live…</span>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <Metric label="Pass rate">
          <PassRate passed={run.passed} total={run.total} />
        </Metric>
        <Metric label="Mean score">
          <Score value={run.score} />
        </Metric>
        <Metric label="Samples">
          <span className="tabular-nums text-neutral-700">{run.total}</span>
        </Metric>
        <Metric label="Started">
          <span className="text-neutral-600">
            {run.startedAt ? formatTimestamp(run.startedAt) : '—'}
          </span>
        </Metric>
        <Metric label="Finished">
          <span className="text-neutral-600">
            {run.finishedAt ? formatTimestamp(run.finishedAt) : '—'}
          </span>
        </Metric>
      </div>
    </div>
  )
}

function Metric({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-neutral-400">
        {label}
      </span>
      {children}
    </div>
  )
}

// One Goal's worth of results. Each result carries a frozen snapshot of the
// Sample + checks it was graded against, so its checkResults[] zip back to what
// it actually asserted even after the Sample is edited. The live set is loaded
// only for the Goal's current name and to resolve results predating snapshots.
function SetSection({
  setId,
  results,
}: {
  setId: string
  results: WfEvalResultDTO[]
}) {
  const { data: set } = useEvalSet(setId)
  const rows = set?.rows ?? []
  const rowById = new Map(rows.map((r) => [r.id, r]))
  // Results for samples that belong to this set (a run may span several sets).
  // Prefer the snapshot's setId — it survives Sample/Goal deletion; fall back to
  // a live-row match for results graded before snapshots existed.
  const own = results.filter(
    (r) => r.snapshot?.target.setId === setId || rowById.has(r.rowId),
  )
  if (rows.length === 0 && own.length === 0) return null

  const setName =
    set?.set.name ?? own[0]?.snapshot?.target.setName ?? 'Goal'

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-neutral-900">{setName}</h2>
        <PassRate
          passed={own.filter((r) => r.status === 'pass').length}
          total={own.length}
        />
      </div>
      {own.length === 0 ? (
        <p className="text-sm text-neutral-400">No results yet.</p>
      ) : (
        <div className="space-y-2">
          {own.map((result) => {
            const snapRow = result.snapshot?.row
            const liveRow = rowById.get(result.rowId)
            return (
              <ResultCard
                key={result.id}
                result={result}
                name={snapRow?.name ?? liveRow?.name ?? result.rowId}
                checks={snapRow?.checks.checks ?? liveRow?.checks.checks ?? []}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function ResultCard({
  result,
  name,
  checks,
}: {
  result: WfEvalResultDTO
  name: string
  checks: EvalCheck[]
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-neutral-100 px-3 py-2">
        <div className="flex items-center gap-2">
          <VerdictBadge status={result.status} />
          <span className="text-sm font-medium text-neutral-800">{name}</span>
        </div>
        <div className="flex items-center gap-3">
          <Score value={result.score} />
          {result.wfRunId && (
            <WfLink
              to={`runs/${result.wfRunId}`}
              className="inline-flex items-center gap-1 text-xs text-neutral-500 transition hover:text-neutral-800"
            >
              run <ExternalLink className="size-3" />
            </WfLink>
          )}
        </div>
      </div>
      <ul className="divide-y divide-neutral-100">
        {result.checkResults.map((cr, i) => (
          <CheckRow key={i} result={cr} check={checks[i]} />
        ))}
      </ul>
    </div>
  )
}

function CheckRow({
  result,
  check,
}: {
  result: CheckResult
  check: EvalCheck | undefined
}) {
  return (
    <li className="flex items-start gap-2 px-3 py-2 text-sm">
      <span
        className={cn(
          'mt-0.5 select-none font-semibold',
          result.pass ? 'text-emerald-600' : 'text-red-600',
        )}
      >
        {result.pass ? '✓' : '✗'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-neutral-700">{describeCheck(check)}</span>
          {result.score != null && (
            <span className="tabular-nums text-xs text-neutral-400">
              {result.score.toFixed(2)}
            </span>
          )}
        </div>
        {result.reason && (
          <p className="mt-0.5 text-xs text-neutral-500">{result.reason}</p>
        )}
      </div>
    </li>
  )
}

function VerdictBadge({ status }: { status: string }) {
  const tone =
    status === 'pass' || status === 'completed'
      ? 'bg-emerald-50 text-emerald-700'
      : status === 'error'
        ? 'bg-amber-50 text-amber-700'
        : status === 'fail' || status === 'failed' || status === 'cancelled'
          ? 'bg-red-50 text-red-700'
          : 'bg-neutral-100 text-neutral-500'
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium',
        tone,
      )}
    >
      {status}
    </span>
  )
}
