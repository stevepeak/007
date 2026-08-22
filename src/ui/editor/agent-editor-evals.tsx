import {
  AlertTriangle,
  ArrowUpRight,
  ChevronDown,
  Goal,
  History,
  Loader2,
  Play,
  Plus,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import type { AgentConfig } from '../../engine'
import type { WfEvalResultDTO, WfEvalSetSummary } from '../../server/protocol'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { formatRelative, formatTimestamp } from '../cost'
import { uniqueGoalName } from '../evals/new-goal-dialog'
import { RunConfigDialog } from '../evals/run-config-dialog'
import { StatusDot } from '../evals/run-report/atoms'
import { buildResultRows } from '../evals/run-report/model'
import { useCreateEvalSet, useEvalRun, useEvalSets, useModels } from '../hooks'
import { useOpenAsset, WfLink } from '../nav'
import { QueryState } from '../query-state'
import { Tooltip } from '../tooltip'

import { changedFields } from './agent-config-diff'

// The agent's goals, runnable from the editor — against the DRAFT.
//
// The gap this closes: a goal has always been runnable from its own page, but
// only ever against the agent's PUBLISHED version. That makes evals a thing you
// consult after committing, when the question an author actually has is the
// opposite one — "does what I just typed still pass?" Answering it used to mean
// publishing a version you had no evidence for, reading the report, and
// publishing again to undo it. Here the whole unsaved config rides along with
// the run (`configOverride` → `agentOverride.config`), so nothing is saved and
// nothing is published to find out.
//
// It sits ABOVE the playground because the two answer different questions in
// increasing order of confidence: the playground shows you ONE answer to ONE
// input you made up; this grades every sample you have ever cared about, against
// checks you wrote when you were thinking clearly. The stronger evidence goes
// first.
//
// Runs are shown INLINE and deliberately never navigate: the report lives at
// `evals/runs/<id>`, and going there would unmount the editor and take the
// unsaved draft under test with it. The full report is one explicit
// new-tab link away.

export function AgentEvalsPanel({
  agentId,
  agentName,
  config,
  /** Load a run's frozen config back into the editor (same contract as the playground). */
  onRestore,
}: {
  agentId: string
  /** The editor's live name — seeds the name of a goal created from here. */
  agentName: string
  config: AgentConfig
  onRestore?: (config: AgentConfig) => void
}) {
  const { Button } = useWfComponents()
  const setsQuery = useEvalSets()

  // This agent's goals. Filtered client-side from the catalog the evals list
  // already loads — a goal is a pointer at a target, so "this agent's evals" is
  // just that pointer read the other way round, and it needs no new endpoint.
  const goals = useMemo(
    () =>
      (setsQuery.data ?? []).filter(
        (s) => s.targetKind === 'agent' && s.targetId === agentId,
      ),
    [setsQuery.data, agentId],
  )

  // Which goals this run covers. Absent an explicit choice everything runnable is
  // in — the common case is "run my evals", not "run this subset" — so the map
  // holds only the exclusions the author actually made.
  const [excluded, setExcluded] = useState<Record<string, boolean>>({})
  const selected = goals.filter((g) => g.rowCount > 0 && !excluded[g.id])
  const totalSamples = selected.reduce((n, g) => n + g.rowCount, 0)

  const [runOpen, setRunOpen] = useState(false)
  // Every run launched from this panel, newest first. Ids only — each card polls
  // its own run — and they live for the life of the page, like playground runs.
  const [runIds, setRunIds] = useState<string[]>([])
  // The draft each run was launched with, frozen. `config` is only ever replaced
  // wholesale by the editor's `patch`, so holding the reference IS the snapshot —
  // and it's what makes a verdict mean something later: "3/4 passed" is only
  // evidence if you can say which configuration earned it.
  const [runConfigs, setRunConfigs] = useState<Record<string, AgentConfig>>({})
  const [expandedId, setExpandedId] = useState<string | null>(null)

  return (
    <div className="space-y-3">
      <aside className="h-fit space-y-3 rounded-xl border border-neutral-200 bg-neutral-50/60 p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-neutral-700">
          <Goal className="size-4 text-rose-500" />
          Evals
          {goals.length > 0 ? (
            <span className="rounded-full bg-neutral-200 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-neutral-600">
              {goals.length}
            </span>
          ) : null}
        </div>
        <p className="text-xs text-neutral-500">
          The goals that grade this agent, run against your{' '}
          <strong className="font-medium text-neutral-700">
            current unsaved edits
          </strong>{' '}
          — so you can see whether a change still passes before you publish it.
          Every sample runs in simulation: write tools no-op and read tools
          return the sample&rsquo;s fixtures.
        </p>

        <QueryState
          query={{ isLoading: setsQuery.isLoading, error: null, data: goals }}
          loading={<p className="text-xs text-neutral-400">Loading goals…</p>}
          isEmpty={(goals) => goals?.length === 0}
          empty={
            <EmptyGoals
              agentId={agentId}
              agentName={agentName}
              existingNames={(setsQuery.data ?? []).map((s) => s.name)}
            />
          }
        >
          {(goals) => (
            <ul className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
              {goals.map((g) => (
                <GoalRow
                  key={g.id}
                  goal={g}
                  checked={g.rowCount > 0 && !excluded[g.id]}
                  onToggle={(on) =>
                    setExcluded((prev) => ({ ...prev, [g.id]: !on }))
                  }
                />
              ))}
            </ul>
          )}
        </QueryState>

        {goals.length > 0 ? (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={selected.length === 0}
              onClick={() => setRunOpen(true)}
              title={
                selected.length === 0
                  ? 'Select a goal with at least one sample to run.'
                  : undefined
              }
            >
              <Play className="size-3.5" />
              Run evals
            </Button>
            <span className="text-[11px] text-neutral-400">
              {selected.length === 0
                ? 'Nothing selected'
                : `${totalSamples} sample${totalSamples === 1 ? '' : 's'} across ${selected.length} goal${selected.length === 1 ? '' : 's'}`}
            </span>
          </div>
        ) : null}
      </aside>

      {runIds.map((id, i) => (
        <EvalRunCard
          key={id}
          evalRunId={id}
          number={runIds.length - i}
          expanded={expandedId === id}
          onToggle={() => setExpandedId(expandedId === id ? null : id)}
          ranConfig={runConfigs[id]}
          liveConfig={config}
          onRestore={onRestore}
        />
      ))}

      <RunConfigDialog
        open={runOpen}
        onClose={() => setRunOpen(false)}
        scope="goal"
        targetName={
          selected.length === 1
            ? (selected[0]?.name ?? 'this agent')
            : `${selected.length} goals`
        }
        setIds={selected.map((g) => g.id)}
        draftConfig={config}
        onLaunched={(evalRunId) => {
          setRunIds((prev) => [evalRunId, ...prev])
          setRunConfigs((prev) => ({ ...prev, [evalRunId]: config }))
          setExpandedId(evalRunId)
        }}
      />
    </div>
  )
}

/**
 * No goals yet — so make one, here.
 *
 * The only decision the new-goal dialog blocks on is which agent to grade, and
 * standing in this editor has already answered it. Sending the author to Evals
 * to pick this agent out of a list is a detour through a question they've
 * implicitly answered, so the button creates the goal outright: this agent,
 * floating to its latest version, named after it.
 *
 * It opens in a NEW tab for the same reason every link out of this panel does —
 * the unsaved draft under test lives in this editor, and unmounting it to go add
 * samples would take the draft with it.
 */
function EmptyGoals({
  agentId,
  agentName,
  existingNames,
}: {
  agentId: string
  agentName: string
  existingNames: string[]
}) {
  const { Button } = useWfComponents()
  const createSet = useCreateEvalSet()
  const openAsset = useOpenAsset()

  const create = async () => {
    const res = await createSet.mutateAsync({
      name: uniqueGoalName(agentName, existingNames),
      targetKind: 'agent',
      targetId: agentId,
      targetVersion: null,
      triggerKind: 'manual',
    })
    openAsset(`evals/${res.setId}`, { newTab: true })
  }

  return (
    <div className="rounded-lg border border-dashed border-neutral-300 bg-white px-3 py-4 text-center">
      <p className="text-xs text-neutral-500">
        No goals target this agent yet.
      </p>
      <Button
        size="sm"
        variant="outline"
        className="mt-2"
        disabled={createSet.isPending}
        onClick={() => void create()}
      >
        {createSet.isPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Plus className="size-3.5" />
        )}
        {createSet.isPending ? 'Creating…' : 'Create a goal'}
      </Button>
      {createSet.isError ? (
        <p className="mt-1 text-xs text-red-600">
          Couldn&rsquo;t create the goal. Try again.
        </p>
      ) : null}
      <p className="mt-1.5 text-[11px] text-neutral-400">
        Grades this agent, floating to its latest version — opens in a new tab so
        you can add samples without losing your draft.
      </p>
    </div>
  )
}

function GoalRow({
  goal,
  checked,
  onToggle,
}: {
  goal: WfEvalSetSummary
  checked: boolean
  onToggle: (on: boolean) => void
}) {
  const { Checkbox } = useWfComponents()
  // A goal with no samples has nothing to grade — it can't be run, and offering
  // a checkbox that silently contributes zero tests would be a lie about what
  // the button is about to do.
  const empty = goal.rowCount === 0
  return (
    <li className="flex items-center gap-2.5 border-b border-neutral-100 px-3 py-2 last:border-b-0">
      <Checkbox
        checked={checked}
        disabled={empty}
        aria-label={`Include ${goal.name}`}
        onChange={(e) => onToggle(e.target.checked)}
      />
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'truncate text-sm',
            empty ? 'text-neutral-400' : 'text-neutral-800',
          )}
        >
          {goal.name}
        </div>
        <div className="text-[11px] text-neutral-400">
          {empty
            ? 'No samples yet'
            : `${goal.rowCount} sample${goal.rowCount === 1 ? '' : 's'}`}
          {goal.targetVersion != null ? ` · pinned v${goal.targetVersion}` : ''}
        </div>
      </div>
      <WfLink
        to={`evals/${goal.id}`}
        newTab
        aria-label={`Open ${goal.name}`}
        className="shrink-0 text-neutral-400 transition hover:text-neutral-700"
      >
        <ArrowUpRight className="size-3.5" />
      </WfLink>
    </li>
  )
}

/**
 * One launched run, polled to completion in place.
 *
 * Deliberately a summary and not a second copy of the report: pass/fail per
 * sample is what an author reads mid-edit, and everything past that — the check
 * breakdown, the matrix roll-up, the graded trace — is one click away in the
 * real report, which has the whole page width to say it properly.
 */
function EvalRunCard({
  evalRunId,
  number,
  expanded,
  onToggle,
  ranConfig,
  liveConfig,
  onRestore,
}: {
  evalRunId: string
  number: number
  expanded: boolean
  onToggle: () => void
  ranConfig?: AgentConfig
  liveConfig: AgentConfig
  onRestore?: (config: AgentConfig) => void
}) {
  const { Button } = useWfComponents()
  const { data } = useEvalRun(evalRunId)
  const models = useModels().data
  const labelOf = useMemo(() => {
    const byId = new Map((models ?? []).map((m) => [m.id, m.label]))
    return (id: string) => byId.get(id)
  }, [models])

  const run = data?.run
  const results = useMemo(() => data?.results ?? [], [data?.results])
  const rows = useMemo(
    () => buildResultRows(results, labelOf),
    [results, labelOf],
  )

  // `run.total` is what was REQUESTED at launch and stays put until the run is
  // finalized, so it's the honest denominator while cells are still landing.
  const total = run?.total ?? 0
  const landed = results.length
  const passed = results.filter((r) => r.status === 'pass').length
  const failed = results.filter((r) => r.status === 'fail').length
  const errored = results.filter((r) => r.status === 'error').length
  const finished = run?.status === 'completed'
  // Only a finished run with every cell passing is a clean bill of health. A run
  // still in flight is deliberately neutral — a green header over three of eight
  // cells reads as "it passed" when the answer isn't in yet.
  const tone = !finished
    ? 'running'
    : failed + errored === 0 && landed > 0
      ? 'pass'
      : failed > 0
        ? 'fail'
        : 'error'

  const changed = ranConfig ? changedFields(ranConfig, liveConfig) : []

  return (
    <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-neutral-50"
      >
        <span
          className={cn(
            'size-2 shrink-0 rounded-full',
            tone === 'running'
              ? 'animate-pulse bg-blue-400'
              : tone === 'pass'
                ? 'bg-emerald-500'
                : tone === 'fail'
                  ? 'bg-red-500'
                  : 'bg-amber-500',
          )}
        />
        <span className="text-sm font-medium text-neutral-800">
          Eval run {number}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs tabular-nums text-neutral-400">
          {finished
            ? `${passed}/${landed} passed`
            : `${landed}/${total || '…'} tests done`}
        </span>
        {run?.createdAt ? (
          <Tooltip content={formatTimestamp(run.createdAt)}>
            <span className="shrink-0 text-[11px] text-neutral-400">
              {formatRelative(run.createdAt)}
            </span>
          </Tooltip>
        ) : null}
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-neutral-400 transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>

      {expanded ? (
        <div className="space-y-3 border-t border-neutral-100 p-3">
          {!finished ? (
            <div className="space-y-1.5">
              <div className="h-1 overflow-hidden rounded-full bg-neutral-100">
                <div
                  className="h-full rounded-full bg-blue-400 transition-[width]"
                  style={{
                    width: total > 0 ? `${(landed / total) * 100}%` : '0%',
                  }}
                />
              </div>
              <p className="flex items-center gap-1.5 text-[11px] text-neutral-400">
                <Loader2 className="size-3 animate-spin" />
                Running — results appear as each test finishes. Leaving this
                page cancels nothing, but you&rsquo;ll lose the unsaved draft it
                ran.
              </p>
            </div>
          ) : null}

          {landed === 0 ? (
            <p className="text-xs text-neutral-400">No results yet.</p>
          ) : (
            <ul className="overflow-hidden rounded-md border border-neutral-200">
              {rows.map((r) => (
                <ResultRowLine key={r.result.id} row={r} />
              ))}
            </ul>
          )}

          {/* The verdict is about a configuration, and the editor has since moved
              on — say so, in the same words the playground uses, rather than
              letting a stale card pass for a current one. */}
          {changed.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800">
              <span className="min-w-0 flex-1">
                Your draft has changed since this run: {changed.join(', ')}.
              </span>
              {onRestore && ranConfig ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onRestore(ranConfig)}
                >
                  <History className="mr-1 size-3.5" />
                  Load what ran
                </Button>
              ) : null}
            </div>
          ) : null}

          <div className="flex items-center justify-between">
            <span className="text-[11px] tabular-nums text-neutral-400">
              {passed} passed · {failed} failed
              {errored > 0 ? ` · ${errored} errored` : ''}
            </span>
            <WfLink
              to={`evals/runs/${evalRunId}`}
              newTab
              className="inline-flex items-center gap-1 text-xs font-medium text-neutral-500 transition hover:text-neutral-800"
            >
              Full report
              <ArrowUpRight className="size-3.5" />
            </WfLink>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function ResultRowLine({
  row,
}: {
  row: ReturnType<typeof buildResultRows>[number]
}) {
  const { result } = row
  return (
    <li className="border-b border-neutral-100 px-2.5 py-1.5 last:border-b-0">
      <div className="flex items-center gap-2">
        <StatusDot status={row.status} />
        <span className="min-w-0 flex-1 truncate text-xs text-neutral-700">
          {row.sampleName}
        </span>
        {row.modelLabel ? (
          <span className="shrink-0 truncate text-[11px] text-neutral-400">
            {row.modelLabel}
          </span>
        ) : null}
        {row.score != null ? (
          <span className="shrink-0 text-[11px] tabular-nums text-neutral-500">
            {row.score.toFixed(2)}
          </span>
        ) : null}
      </div>
      {/* The one line that tells a zero pass rate apart from a broken provider.
          Shown inline because the alternative is an unexplained red row. */}
      {result.error ? (
        <p className="mt-1 flex items-start gap-1 text-[11px] text-amber-700">
          <AlertTriangle className="mt-px size-3 shrink-0" />
          <span className="min-w-0 break-words">{errorLine(result)}</span>
        </p>
      ) : null}
    </li>
  )
}

// Provider errors arrive as whole response bodies; the card has one line for it
// and the full text is in the report.
const MAX_INLINE_ERROR = 160
function errorLine(result: WfEvalResultDTO): string {
  const text = (result.error ?? '').trim()
  return text.length > MAX_INLINE_ERROR
    ? `${text.slice(0, MAX_INLINE_ERROR)}…`
    : text
}
