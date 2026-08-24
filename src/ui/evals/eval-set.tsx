import { ArrowUpRight, Goal, Pencil, Play, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { WfEvalRowDTO } from '../../server/protocol'
import { ActivityList } from '../activity/activity-list'
import { agentColor, agentIcon } from '../agent-appearance'
import { AgentSelect, type AgentSelectValue } from '../agent-select'
import { ArchiveButton } from '../archive-button'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { useAgents, useEvalRuns, useEvalSet, useUpdateEvalSet, useUpsertEvalRow } from '../hooks'
import { IdeaSpark } from '../idea-spark'
import { useOpenAsset, useWfNav, WfLink } from '../nav'
import { pendingLabel, QueryState } from '../query-state'
import { SaveStateBadge } from '../save-state-badge'
import { WfShell } from '../shell'
import { useUndoStack } from '../undo/use-undo-stack'
import { useUnsavedGuard } from '../undo/use-unsaved-guard'
import { sectionCrumb } from '../wf-crumbs'

import {
  describeGoalChange,
  type GoalDraft,
} from './describe-sample-change'
import { RunConfigDialog } from './run-config-dialog'
import { EmptyState, EvalRunsTable, Tabs } from './shared'

// The Goal detail page (route: evals/<setId>). A goal is a wf_eval_set: its
// name + description are editable in place, its TARGET (the agent its samples
// run against) is chosen here, and it can be archived. Two tabs: its SAMPLES
// (wf_eval_row) and the TEST RUNS that included it. (Internal identifiers still
// use `set`/`setId`.)

type SetTab = 'samples' | 'runs' | 'activity'

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

  // The goal's editable half, on an undo stack and written only on Save — the
  // same model the samples use, so one page doesn't have two save behaviours.
  //
  // `reset` rather than `load`, because the stack is created before the set
  // arrives: loading would leave the empty seed underneath as a history entry,
  // and one Cmd+Z too many would blank the title.
  const history = useUndoStack<GoalDraft>({
    initial: { name: '', description: '' },
    describe: describeGoalChange,
    coalesce: (_a, _b, label) =>
      label.startsWith('Edited') ? { key: label, windowMs: 600 } : null,
    enabled: set != null,
  })
  const { name, description } = history.state
  const syncedIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (set && syncedIdRef.current !== set.id) {
      syncedIdRef.current = set.id
      history.reset({ name: set.name, description: set.description ?? '' })
    }
  }, [set, history])

  const save = useCallback(async () => {
    if (!set) return
    await updateSet.mutateAsync({
      setId,
      name: name.trim() || 'Untitled goal',
      description: description || null,
    })
    history.markSaved()
  }, [set, setId, name, description, updateSet, history])

  const saveIfDirty = useCallback(async () => {
    if (history.dirty) await save()
  }, [history.dirty, save])

  useUnsavedGuard(history.dirty, `Goal: ${name || 'Untitled'}`)

  const addSample = async () => {
    // Creating a sample navigates away from this goal. Anything unsaved in the
    // title or description would go with it.
    await saveIfDirty()
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
      titleIcon={<Goal className="size-5 shrink-0 text-rose-500" />}
      assetLabel="Goal"
      crumbs={[
        sectionCrumb('evals'),
        set
          ? {
              editable: {
                value: name,
                onChange: (next) => history.record({ ...history.state, name: next }),
                // Blur ends the edit; the Save button owns the write.
                onCommit: () => {},
                ariaLabel: 'Goal name',
              },
            }
          : { label: 'Goal' },
      ]}
      descriptionEditable={
        set
          ? {
              value: description,
              onChange: (next) =>
                history.record({ ...history.state, description: next }),
              onCommit: () => {},
              ariaLabel: 'Goal description',
            }
          : undefined
      }
      actions={
        set ? (
          <>
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
            <SaveStateBadge
              dirty={history.dirty}
              dirtyTooltip="You have unsaved changes to this goal"
              savedTooltip="All goal changes saved"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => void save()}
              disabled={!history.dirty || updateSet.isPending}
            >
              {updateSet.isPending ? 'Saving…' : 'Save'}
            </Button>
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
              onClick={() => {
                // What you see is what runs.
                void saveIfDirty().then(() => setRunOpen(true))
              }}
            >
              <Play className="size-4" />
              Run Goal
            </Button>
            <IdeaSpark
              title="Recommend the models most likely to pass"
              hint="Idea: AI suggests which models to run before you pick"
            >
              <p>
                Choosing which models to run is a guess today. When you open the
                run dialog, AI could first read this goal&apos;s{' '}
                <strong>requirements</strong> — its samples, checks, and the
                behavior they demand — and predict which models are{' '}
                <strong>most likely to perform best</strong>.
              </p>
              <p>
                You&apos;d see a short, reasoned shortlist — “these three fit the
                tool-use and latency this goal needs” — so the model picker is an
                informed choice instead of a shot in the dark. It could even flag
                models that are likely to fail outright and save you a run.
              </p>
            </IdeaSpark>
          </>
        ) : undefined
      }
    >
      <div className="mx-auto max-w-5xl space-y-5 p-6">
        <QueryState
          query={{ isLoading, error: null, data: set }}
          loading={<EmptyState message="Loading goal…" />}
          empty={
            <EmptyState message="This goal doesn't exist, or was archived / removed." />
          }
        >
          {(set) => (
            <>
              <TargetRow
                setId={setId}
                targetId={set.targetId}
                targetVersion={set.targetVersion}
              />

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
                  { key: 'activity', label: 'Activity' },
                ]}
              />

              {tab === 'samples' ? (
                <SamplesTable setId={setId} rows={rows} />
              ) : tab === 'runs' ? (
                <RunsForSet setId={setId} />
              ) : (
                // Filtered by PARENT, so the goal's history includes edits to
                // its samples — which is where the grading criteria live, and so
                // where "did the test change?" is actually answered.
                <ActivityList
                  filter={{ parentId: setId }}
                  emptyMessage="No changes recorded for this goal's samples yet."
                />
              )}
            </>
          )}
        </QueryState>
      </div>
    </WfShell>
  )
}

// The set-level target: which agent the goal's samples run against. Editable in
// place — pick a different agent or pin/float its version. Changing the target
// keeps the goal's Samples but they were authored against the previous agent, so
// their Given fields and mock fixtures may no longer line up (surfaced with a
// warning while editing).
function TargetRow({
  setId,
  targetId,
  targetVersion,
}: {
  setId: string
  targetId: string
  targetVersion: number | null
}) {
  const { Button } = useWfComponents()
  const agentsQuery = useAgents()
  const updateSet = useUpdateEvalSet()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<AgentSelectValue>({
    agentId: targetId,
    version: targetVersion,
  })

  const agent = agentsQuery.data?.find((a) => a.id === targetId)
  const Icon = agentIcon(agent?.icon)
  const color = agentColor(agent?.color)

  const startEdit = () => {
    setDraft({ agentId: targetId, version: targetVersion })
    setEditing(true)
  }

  const changed = draft.agentId !== targetId || draft.version !== targetVersion
  const canSave = !!draft.agentId && changed && !updateSet.isPending

  const save = async () => {
    if (!canSave) return
    await updateSet.mutateAsync({
      setId,
      targetKind: 'agent',
      targetId: draft.agentId,
      targetVersion: draft.version,
    })
    setEditing(false)
  }

  if (editing) {
    const swappingAgent = draft.agentId !== targetId
    return (
      <div className="space-y-3 rounded-lg border border-neutral-200 bg-neutral-50/60 px-4 py-3">
        <AgentSelect
          agents={agentsQuery.data ?? []}
          value={draft}
          onChange={setDraft}
          disabled={updateSet.isPending}
          placeholder={
            agentsQuery.isLoading ? 'Loading agents…' : 'Select an agent…'
          }
        />
        {swappingAgent ? (
          <p className="text-xs text-amber-600">
            Heads up: this goal&apos;s samples were authored against the current
            agent. Their Given fields and mock fixtures may not line up with the
            new agent — review each sample after switching.
          </p>
        ) : (
          <p className="text-xs text-neutral-400">
            {draft.version == null
              ? 'Floats to the latest published version.'
              : `Pinned to v${draft.version}.`}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={updateSet.isPending}
            onClick={() => setEditing(false)}
          >
            Cancel
          </Button>
          <Button size="sm" disabled={!canSave} onClick={() => void save()}>
            {updateSet.isPending ? 'Saving…' : 'Save target'}
          </Button>
        </div>
      </div>
    )
  }

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
        {pendingLabel(agentsQuery, agent?.name, 'Unknown agent')}
      </div>
      <span className="shrink-0 rounded-full border border-neutral-200 bg-white px-2 py-0.5 text-[11px] font-medium tabular-nums text-neutral-500">
        {targetVersion == null ? 'Latest' : `v${targetVersion}`}
      </span>
      <button
        type="button"
        onClick={startEdit}
        className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-neutral-500 transition hover:text-neutral-800"
      >
        <Pencil className="size-3.5" />
        Change
      </button>
      <WfLink
        to={`agents/${targetId}/edit`}
        newTab
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
  const open = useOpenAsset()
  if (rows.length === 0) {
    return (
      <EmptyState message="No samples yet. Add one to define a Given (initial state) and its Checks." />
    )
  }
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200">
      <div className="grid grid-cols-[1fr_auto] items-center gap-4 border-b border-neutral-100 bg-neutral-50 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        <span>Sample</span>
        <span className="w-16 text-right">Checks</span>
      </div>
      {rows.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={(e) =>
            open(`evals/${setId}/samples/${r.id}`, {
              newTab: e.metaKey || e.ctrlKey,
            })
          }
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
            {r.checks.checks.length === 0 ? (
              // Every new sample starts with zero checks, so this is the state a
              // half-finished sample sits in — and it now grades as an error.
              // The pill makes it findable from the list without opening each
              // one; the tooltip carries the why without widening the column.
              <span
                title="No checks — this sample will report as an error"
                className="inline-flex items-center rounded-md bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700"
              >
                0
              </span>
            ) : (
              r.checks.checks.length
            )}
          </div>
        </button>
      ))}
    </div>
  )
}

// Test runs that included this set. Filtered from the global run history (there
// is no per-set run table — a run spans one or more sets by `setIds`).
function RunsForSet({ setId }: { setId: string }) {
  const open = useOpenAsset()
  const runsQuery = useEvalRuns()
  const runs = (runsQuery.data ?? []).filter((r) => r.setIds.includes(setId))
  return (
    <EvalRunsTable
      runs={runs}
      isLoading={runsQuery.isLoading}
      loadingMessage="Loading test runs…"
      emptyMessage="No test runs yet. Run this goal to see results here."
      onOpenRun={(id, e) =>
        open(`evals/runs/${id}`, { newTab: e.metaKey || e.ctrlKey })
      }
    />
  )
}
