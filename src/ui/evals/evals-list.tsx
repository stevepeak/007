import { CircleDashed, HelpCircle, Play, Plus } from 'lucide-react'
import { useState } from 'react'

import { cn } from '../cn'
import { useWfComponents } from '../context'
import { useWfNav } from '../nav'
import { EvalsHelpDialog } from './evals-help-dialog'
import { MOCK_EVAL_RUNS, type MockEvalRun } from './mock-data'
import {
  listGoals,
  listSamples,
  useEvalsRevision,
  type Goal,
} from './mock-store'
import { NewGoalDialog } from './new-goal-dialog'
import { EmptyState, PassRate, Score, Tabs } from './shared'

// The Evals catalog — the landing page reached from the hub's "Evals" card. Two
// tabs: the authored GOALS (from the mock store), and the history of TEST RUNS.
// "New goal" creates via the store; goal rows navigate into the goal.

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

  useEvalsRevision()
  const goals = listGoals()
  const runs = MOCK_EVAL_RUNS

  return (
    <div className={cn('mx-auto max-w-3xl space-y-5 p-6', className)}>
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-md text-sm text-neutral-500">
          Test agents and workflows against expected outcomes. Runs execute in
          simulation under the eval tenant — no real side effects.
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
          <Button size="sm">
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

      <Tabs
        active={tab}
        onChange={(k) => setTab(k as EvalsTab)}
        tabs={[
          { key: 'sets', label: 'Goals', count: goals.length },
          { key: 'runs', label: 'Test runs', count: runs.length },
        ]}
      />

      {tab === 'sets' ? <GoalsTable goals={goals} /> : <RunsTable runs={runs} />}
    </div>
  )
}

// ── Goals ────────────────────────────────────────────────────────────────────

function GoalsTable({ goals }: { goals: Goal[] }) {
  const { navigate } = useWfNav()
  if (goals.length === 0) {
    return <EmptyState message="No goals yet. Create one to get started." />
  }
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200">
      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-neutral-100 bg-neutral-50 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        <span>Goals</span>
        <span className="text-right">Samples</span>
        <span className="w-40 text-right">Last run</span>
      </div>
      {goals.map((g) => (
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
          <div className="text-right text-sm tabular-nums text-neutral-500">
            {listSamples(g.id).length}
          </div>
          <div className="w-40 text-right">
            {g.lastRun ? (
              <div className="flex items-center justify-end gap-2">
                <PassRate passed={g.lastRun.passed} total={g.lastRun.total} />
                <Score value={g.lastRun.score} />
                <span className="w-12 text-right text-xs text-neutral-400">
                  {g.lastRun.at}
                </span>
              </div>
            ) : (
              <span className="text-xs text-neutral-400">never run</span>
            )}
          </div>
        </button>
      ))}
    </div>
  )
}

// ── Test runs ────────────────────────────────────────────────────────────────

function RunsTable({ runs }: { runs: MockEvalRun[] }) {
  if (runs.length === 0) {
    return (
      <EmptyState message="No test runs yet. Run a goal to see results here." />
    )
  }
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200">
      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-neutral-100 bg-neutral-50 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        <span>When / goals</span>
        <span className="text-right">Pass</span>
        <span className="w-24 text-right">Score</span>
      </div>
      {runs.map((r) => (
        <div
          key={r.id}
          className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-neutral-100 px-4 py-3 last:border-b-0 hover:bg-neutral-50"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-neutral-900">
                {r.at}
              </span>
              <RunStatusBadge status={r.status} />
            </div>
            <div className="mt-0.5 truncate text-xs text-neutral-500">
              {r.sets.join(' · ')}
            </div>
          </div>
          <div className="text-right">
            <PassRate passed={r.passed} total={r.total} />
          </div>
          <div className="w-24 text-right">
            <Score value={r.score} />
          </div>
        </div>
      ))}
    </div>
  )
}

function RunStatusBadge({ status }: { status: MockEvalRun['status'] }) {
  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700">
        <CircleDashed className="size-3 animate-spin" />
        running
      </span>
    )
  }
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[11px] font-medium',
        status === 'failed'
          ? 'bg-red-50 text-red-700'
          : 'bg-neutral-100 text-neutral-500',
      )}
    >
      {status}
    </span>
  )
}
