import { Archive, Play, Plus } from 'lucide-react'
import { useState } from 'react'

import { useWfComponents } from '../context'
import { useWfNav } from '../nav'
import { WfShell } from '../shell'
import { getMockRunHistory } from './mock-data'
import {
  archiveGoal,
  createSample,
  currentSampleVersion,
  getGoal,
  listSamples,
  listTests,
  updateGoal,
  useEvalsRevision,
  type Sample,
} from './mock-store'
import {
  EmptyState,
  KindBadge,
  Score,
  StatusPill,
  Tabs,
  TestRunsTable,
} from './shared'

// The Goal detail page (route: evals/<setId>). A goal is a FOLDER (not
// versioned): its name + description are editable in place, and it can be
// archived. Two tabs: its SAMPLES (from the mock store) and the TEST RUNS that
// touched it. (Internal identifiers still use `set`/`setId`.)

type SetTab = 'samples' | 'runs'

export type EvalSetProps = {
  setId: string
  className?: string
}

export function EvalSet({ setId, className }: EvalSetProps) {
  const { Button, Textarea } = useWfComponents()
  const { navigate } = useWfNav()
  const [tab, setTab] = useState<SetTab>('samples')

  useEvalsRevision()
  const goal = getGoal(setId)

  const [name, setName] = useState(goal?.name ?? '')
  const [description, setDescription] = useState(goal?.description ?? '')

  const samples = listSamples(setId)
  const runs = getMockRunHistory(setId, goal?.lastRun?.score != null)

  return (
    <WfShell
      className={className}
      scroll
      crumbs={[
        { home: true },
        { label: 'Goals', to: 'evals' },
        goal
          ? {
              editable: {
                value: name,
                onChange: setName,
                onCommit: () =>
                  updateGoal(setId, { name: name.trim() || 'Untitled goal' }),
                ariaLabel: 'Goal name',
              },
            }
          : { label: 'Goal' },
      ]}
    >
      <div className="mx-auto max-w-3xl space-y-5 p-6">
        {!goal ? (
          <EmptyState message="This goal doesn't exist, or was archived / removed." />
        ) : (
          <>
            <div className="flex items-start justify-between gap-4">
              <Textarea
                rows={2}
                value={description}
                placeholder="Describe the outcome this goal guarantees…"
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => updateGoal(setId, { description })}
                className="max-w-md text-sm"
              />
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    archiveGoal(setId)
                    navigate('evals')
                  }}
                >
                  <Archive className="size-4" />
                  Archive
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigate(`evals/${setId}/samples/${createSample(setId)}`)}
                >
                  <Plus className="size-4" />
                  Add sample
                </Button>
                <Button size="sm">
                  <Play className="size-4" />
                  Run this goal
                </Button>
              </div>
            </div>

            <Tabs
              active={tab}
              onChange={(k) => setTab(k as SetTab)}
              tabs={[
                { key: 'samples', label: 'Samples', count: samples.length },
                { key: 'runs', label: 'Test runs', count: runs.length },
              ]}
            />

            {tab === 'samples' ? (
              <SamplesTable setId={setId} samples={samples} />
            ) : (
              <TestRunsTable rows={runs} />
            )}
          </>
        )}
      </div>
    </WfShell>
  )
}

function SamplesTable({
  setId,
  samples,
}: {
  setId: string
  samples: Sample[]
}) {
  const { navigate } = useWfNav()
  if (samples.length === 0) {
    return (
      <EmptyState message="No samples yet. Add one to define a Given, what's tested, and its Tests." />
    )
  }
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200">
      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-neutral-100 bg-neutral-50 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        <span>Sample</span>
        <span className="text-right">Tests</span>
        <span className="w-28 text-right">Last result</span>
      </div>
      {samples.map((s) => {
        const cfg = currentSampleVersion(s).config
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => navigate(`evals/${setId}/samples/${s.id}`)}
            className="grid w-full grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-neutral-100 px-4 py-3 text-left last:border-b-0 hover:bg-neutral-50"
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-neutral-900">
                {cfg.name}
              </div>
              <div className="mt-1 flex items-start gap-2">
                <KindBadge kind={cfg.kind} />
                {cfg.summary ? (
                  <span className="min-w-0 text-xs leading-relaxed text-neutral-500">
                    {cfg.summary}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="text-right text-sm tabular-nums text-neutral-500">
              {listTests(s.id).length}
            </div>
            <div className="w-28 text-right">
              {s.lastResult ? (
                <div className="flex items-center justify-end gap-2">
                  <StatusPill status={s.lastResult.status} />
                  <Score value={s.lastResult.score} />
                </div>
              ) : (
                <span className="text-xs text-neutral-400">—</span>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}
