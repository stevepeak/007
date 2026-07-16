import { ArrowUpRight, Play, Plus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { WfEvalRowDTO } from '../../server/protocol'
import { agentColor, agentIcon } from '../agent-appearance'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { useAgents, useEvalRuns, useEvalSet, useUpdateEvalSet, useUpsertEvalRow } from '../hooks'
import { useWfNav, WfLink } from '../nav'
import { ArchiveButton } from '../archive-button'
import { WfShell } from '../shell'
import { sectionCrumb } from '../wf-crumbs'
import { RunConfigDialog } from './run-config-dialog'
import { EmptyState, formatTimestamp, PassRate, Score, Tabs } from './shared'

// The Goal detail page (route: evals/<setId>). A goal is a wf_eval_set: its
// name + description are editable in place, its TARGET (the agent its samples
// run against) is chosen here, and it can be archived. Two tabs: its SAMPLES
// (wf_eval_row) and the TEST RUNS that included it. (Internal identifiers still
// use `set`/`setId`.)

type SetTab = 'samples' | 'runs'

export type EvalSetProps = {
  setId: string
  className?: string
}

export function EvalSet({ setId, className }: EvalSetProps) {
  const { Button } = useWfComponents()
  const { navigate } = useWfNav()
  const [tab, setTab] = useState<SetTab>('samples')
  const [runOpen, setRunOpen] = useState(false)

  const { data, isLoading } = useEvalSet(setId)
  const set = data?.set
  const rows = useMemo(() => data?.rows ?? [], [data?.rows])

  const updateSet = useUpdateEvalSet()
  const upsertRow = useUpsertEvalRow()

  // Local name/description, synced once per set id so background refetches don't
  // clobber an in-progress edit (persisted on blur).
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const syncedId = useRef<string | null>(null)
  useEffect(() => {
    if (set && syncedId.current !== set.id) {
      setName(set.name)
      setDescription(set.description ?? '')
      syncedId.current = set.id
    }
  }, [set])

  const addSample = async () => {
    const { rowId } = await upsertRow.mutateAsync({
      setId,
      name: 'Untitled sample',
      checks: { op: 'and', checks: [] },
      sortOrder: rows.length,
    })
    navigate(`evals/${setId}/samples/${rowId}`)
  }

  return (
    <WfShell
      className={className}
      scroll
      crumbs={[
        { home: true },
        sectionCrumb('evals'),
        { label: set ? name || 'Untitled goal' : 'Goal' },
      ]}
    >
      <div className="mx-auto max-w-5xl space-y-5 p-6">
        {isLoading && !set ? (
          <EmptyState message="Loading goal…" />
        ) : !set ? (
          <EmptyState message="This goal doesn't exist, or was archived / removed." />
        ) : (
          <>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <input
                  value={name}
                  maxLength={60}
                  placeholder="Untitled goal"
                  aria-label="Goal name"
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => {
                    const next = name.trim() || 'Untitled goal'
                    if (next !== set.name)
                      updateSet.mutate({ setId, name: next })
                  }}
                  className="w-full truncate rounded bg-transparent text-lg font-semibold text-neutral-900 outline-none placeholder:text-neutral-300 focus:bg-neutral-50"
                />
                <textarea
                  value={description}
                  rows={1}
                  placeholder="Add a description…"
                  aria-label="Goal description"
                  onChange={(e) => setDescription(e.target.value)}
                  onBlur={() => {
                    if (description !== (set.description ?? ''))
                      updateSet.mutate({ setId, description: description || null })
                  }}
                  className="w-full resize-none rounded bg-transparent text-sm text-neutral-600 outline-none placeholder:text-neutral-300 focus:bg-neutral-50"
                />
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <ArchiveButton
                  description={
                    <>
                      Archive <strong>{name || 'this goal'}</strong>? It’ll be
                      removed from your goals list.
                    </>
                  }
                  onConfirm={() => {
                    updateSet.mutate({ setId, archived: true })
                    navigate('evals')
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={upsertRow.isPending}
                  onClick={() => void addSample()}
                >
                  <Plus className="size-4" />
                  Add sample
                </Button>
                <Button
                  size="sm"
                  disabled={rows.length === 0}
                  onClick={() => setRunOpen(true)}
                >
                  <Play className="size-4" />
                  Run this goal
                </Button>
              </div>
            </div>

            <TargetRow targetId={set.targetId} />

            <RunConfigDialog
              open={runOpen}
              onClose={() => setRunOpen(false)}
              scope="goal"
              targetName={set.name}
              setIds={[setId]}
            />

            <Tabs
              active={tab}
              onChange={(k) => setTab(k as SetTab)}
              tabs={[
                { key: 'samples', label: 'Samples' },
                { key: 'runs', label: 'Test runs' },
              ]}
            />

            {tab === 'samples' ? (
              <SamplesTable setId={setId} rows={rows} />
            ) : (
              <RunsForSet setId={setId} />
            )}
          </>
        )}
      </div>
    </WfShell>
  )
}

// The set-level target: which agent the goal's samples run against. Fixed once
// the goal is created — every sample's Given fields and mock fixtures reflect
// from this agent, so swapping it would orphan them. Read-only here; to target a
// different agent, create a new goal.
function TargetRow({ targetId }: { targetId: string }) {
  const agentsQuery = useAgents()
  const agent = agentsQuery.data?.find((a) => a.id === targetId)
  const Icon = agentIcon(agent?.icon)
  const color = agentColor(agent?.color)
  return (
    <div className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-neutral-50/60 px-4 py-3">
      <span
        className={cn(
          'inline-flex size-8 shrink-0 items-center justify-center rounded-lg',
          color.chip,
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 text-sm font-medium text-neutral-800">
        {agent?.name ?? (agentsQuery.isLoading ? 'Loading…' : 'Unknown agent')}
      </div>
      <WfLink
        to={`agents/${targetId}/edit`}
        className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-neutral-500 transition hover:text-neutral-800"
      >
        Open agent
        <ArrowUpRight className="size-3.5" />
      </WfLink>
    </div>
  )
}

function SamplesTable({
  setId,
  rows,
}: {
  setId: string
  rows: WfEvalRowDTO[]
}) {
  const { navigate } = useWfNav()
  if (rows.length === 0) {
    return (
      <EmptyState message="No samples yet. Add one to define a Given (initial state) and its Tests." />
    )
  }
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200">
      <div className="grid grid-cols-[1fr_auto] items-center gap-4 border-b border-neutral-100 bg-neutral-50 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        <span>Sample</span>
        <span className="w-16 text-right">Tests</span>
      </div>
      {rows.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => navigate(`evals/${setId}/samples/${r.id}`)}
          className="grid w-full grid-cols-[1fr_auto] items-center gap-4 border-b border-neutral-100 px-4 py-3 text-left last:border-b-0 hover:bg-neutral-50"
        >
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-neutral-900">
              {r.name}
            </div>
            {r.description ? (
              <div className="mt-0.5 truncate text-xs text-neutral-500">
                {r.description}
              </div>
            ) : null}
          </div>
          <div className="w-16 text-right text-sm tabular-nums text-neutral-500">
            {r.checks.checks.length}
          </div>
        </button>
      ))}
    </div>
  )
}

// Test runs that included this set. Filtered from the global run history (there
// is no per-set run table — a run spans one or more sets by `setIds`).
function RunsForSet({ setId }: { setId: string }) {
  const { navigate } = useWfNav()
  const runsQuery = useEvalRuns()
  const runs = (runsQuery.data ?? []).filter((r) => r.setIds.includes(setId))
  if (runsQuery.isLoading) return <EmptyState message="Loading test runs…" />
  if (runs.length === 0) {
    return <EmptyState message="No test runs yet. Run this goal to see results here." />
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
          <div className="flex items-center gap-2">
            <span className="text-sm text-neutral-700">
              {formatTimestamp(r.createdAt)}
            </span>
            <span className="text-xs text-neutral-400">{r.status}</span>
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
