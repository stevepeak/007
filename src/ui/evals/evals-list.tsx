import { CircleDashed, HelpCircle, Play, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'

import type {
  WfEvalRunSummary,
  WfEvalSetSummary,
} from '../../server/protocol'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { useAgents, useEvalRuns, useEvalSets } from '../hooks'
import { useWfNav } from '../nav'
import { EvalsHelpDialog } from './evals-help-dialog'
import { NewGoalDialog } from './new-goal-dialog'
import { RunConfigDialog } from './run-config-dialog'
import { EmptyState, formatTimestamp, KindBadge, PassRate, Score, Tabs } from './shared'

// The Evals catalog — the landing page reached from the hub's "Evals" card. Two
// tabs: the authored GOALS (real wf_eval_set rows) and the history of TEST RUNS
// (real wf_eval_run rows). "New goal" creates a set; goal rows drill in; a run
// row opens its report.

type EvalsTab = 'sets' | 'runs'

export type EvalsListProps = {
  className?: string
}

export function EvalsList({ className }: EvalsListProps) {
  const { Button } = useWfComponents()
  const { navigate } = useWfNav()
  const [tab, setTab] = useState<EvalsTab>('sets')
  const [helpOpen, setHelpOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [runOpen, setRunOpen] = useState(false)

  const setsQuery = useEvalSets()
  const runsQuery = useEvalRuns()
  const goals = useMemo(() => setsQuery.data ?? [], [setsQuery.data])
  const runs = runsQuery.data ?? []
  const allSetIds = useMemo(() => goals.map((g) => g.id), [goals])

  return (
    <div className={cn('mx-auto max-w-5xl space-y-5 p-6', className)}>
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-md text-sm text-neutral-500">
          Test agents and workflows against expected outcomes. Runs execute in
          simulation — write tools no-op and read tools return canned fixtures,
          so no real side effects.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            aria-label="How Evals work"
            onClick={() => setHelpOpen(true)}
            className="inline-flex size-8 items-center justify-center rounded-md text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
          >
            <HelpCircle className="size-4" />
          </button>
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            New goal
          </Button>
          <Button
            size="sm"
            disabled={allSetIds.length === 0}
            onClick={() => setRunOpen(true)}
          >
            <Play className="size-4" />
            Run tests
          </Button>
        </div>
      </div>

      <EvalsHelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      <NewGoalDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false)
          navigate(`evals/${id}`)
        }}
      />
      <RunConfigDialog
        open={runOpen}
        onClose={() => setRunOpen(false)}
        scope="goal"
        targetName={`all goals (${allSetIds.length})`}
        setIds={allSetIds}
      />

      <Tabs
        active={tab}
        onChange={(k) => setTab(k as EvalsTab)}
        tabs={[
          { key: 'sets', label: 'Goals', count: goals.length },
          { key: 'runs', label: 'Test runs', count: runs.length },
        ]}
      />

      {tab === 'sets' ? (
        setsQuery.isLoading ? (
          <EmptyState message="Loading goals…" />
        ) : (
          <GoalsTable goals={goals} />
        )
      ) : runsQuery.isLoading ? (
        <EmptyState message="Loading test runs…" />
      ) : (
        <RunsTable runs={runs} />
      )}
    </div>
  )
}

// ── Goals ────────────────────────────────────────────────────────────────────

function GoalsTable({ goals }: { goals: WfEvalSetSummary[] }) {
  const { navigate } = useWfNav()
  const agentsQuery = useAgents()
  const agentById = useMemo(
    () => new Map((agentsQuery.data ?? []).map((a) => [a.id, a])),
    [agentsQuery.data],
  )

  if (goals.length === 0) {
    return <EmptyState message="No goals yet. Create one to get started." />
  }
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200">
      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-neutral-100 bg-neutral-50 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        <span>Goals</span>
        <span>Target</span>
        <span className="w-20 text-right">Samples</span>
      </div>
      {goals.map((g) => {
        const targetName =
          g.targetKind === 'agent'
            ? (agentById.get(g.targetId)?.name ?? 'Unknown agent')
            : 'Workflow'
        return (
          <button
            key={g.id}
            type="button"
            onClick={() => navigate(`evals/${g.id}`)}
            className="grid w-full grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-neutral-100 px-4 py-3 text-left last:border-b-0 hover:bg-neutral-50"
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-neutral-900">
                {g.name}
              </div>
              {g.description ? (
                <div className="mt-0.5 truncate text-xs text-neutral-500">
                  {g.description}
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <KindBadge kind={g.targetKind} />
              <span className="max-w-[10rem] truncate text-sm text-neutral-600">
                {targetName}
              </span>
            </div>
            <div className="w-20 text-right text-sm tabular-nums text-neutral-500">
              {g.rowCount}
            </div>
          </button>
        )
      })}
    </div>
  )
}

// ── Test runs ────────────────────────────────────────────────────────────────

function RunsTable({ runs }: { runs: WfEvalRunSummary[] }) {
  const { navigate } = useWfNav()
  if (runs.length === 0) {
    return (
      <EmptyState message="No test runs yet. Run a goal to see results here." />
    )
  }
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200">
      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-neutral-100 bg-neutral-50 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        <span>When</span>
        <span className="text-right">Pass</span>
        <span className="w-24 text-right">Score</span>
      </div>
      {runs.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => navigate(`evals/runs/${r.id}`)}
          className="grid w-full grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-neutral-100 px-4 py-3 text-left last:border-b-0 hover:bg-neutral-50"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-neutral-900">
                {formatTimestamp(r.createdAt)}
              </span>
              <RunStatusBadge status={r.status} />
            </div>
            <div className="mt-0.5 truncate text-xs text-neutral-500">
              {r.setIds.length} goal{r.setIds.length === 1 ? '' : 's'} ·{' '}
              {r.total} sample{r.total === 1 ? '' : 's'}
            </div>
          </div>
          <div className="text-right">
            <PassRate passed={r.passed} total={r.total} />
          </div>
          <div className="w-24 text-right">
            <Score value={r.score} />
          </div>
        </button>
      ))}
    </div>
  )
}

function RunStatusBadge({ status }: { status: string }) {
  if (status === 'running' || status === 'queued') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700">
        <CircleDashed className="size-3 animate-spin" />
        {status}
      </span>
    )
  }
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[11px] font-medium',
        status === 'failed' || status === 'cancelled'
          ? 'bg-red-50 text-red-700'
          : 'bg-neutral-100 text-neutral-500',
      )}
    >
      {status}
    </span>
  )
}
